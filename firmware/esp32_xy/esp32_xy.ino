// enryo-killer Plan B: 磁石 XY ガントリー (ESP32 + ステッピング 2 軸)
// wss://<WS_HOST>/api/rooms/<ROOM_CODE>/device/ws に繋ぎ、
//   {"t":"xy","seq":12,"active":true,"estop":false,"ttlMs":1500,"x":0.31,"y":-0.05,...}
// を受けて磁石をその座標 (卓中心原点、1.0 = PLAY_RADIUS_MM、+x=東 +y=南) へ動かす。
// {"payload":...} (タイヤ用) は無視。必要ライブラリ: "WebSockets" by Markus Sattler
//
// 構成: core0 のタスクで WebSocket、loop() (core1) はモーション専用 (ブロックしない)。
#include <WiFi.h>
#include <WebSocketsClient.h>
#if __has_include("config.h")
#include "config.h"
#else
#include "config.example.h"
#endif

// ===================== 共有状態 (WS タスク -> モーション) =====================
portMUX_TYPE mux = portMUX_INITIALIZER_UNLOCKED;
volatile float tgtXmm = 0, tgtYmm = 0;
volatile bool  gActive = false, gEstop = false;
volatile uint32_t lastMsgAt = 0;
volatile bool  wsUp = false;

// ===================== 1 軸 (台形加速、ノンブロッキング) =====================
struct Axis {
  long pos = 0, target = 0;     // steps
  float v = 0;                  // steps/s (符号付き)
  float vmax = 1000, acc = 1000; // steps/s, steps/s^2
  uint32_t lastStepUs = 0, lastUpdUs = 0;
  int dirSign = 1;
  uint8_t phase = 0;            // ULN2003 用
  int p[4];                     // STEPDIR: p[0]=STEP p[1]=DIR / ULN2003: IN1..4

  void begin() {
#if DRIVER_TYPE == DRIVER_STEPDIR
    pinMode(p[0], OUTPUT); pinMode(p[1], OUTPUT);
#else
    for (int i = 0; i < 4; i++) pinMode(p[i], OUTPUT);
#endif
  }
  void coils(bool on) {
#if DRIVER_TYPE == DRIVER_ULN2003
    static const uint8_t HS[8] = {0b1000, 0b1100, 0b0100, 0b0110, 0b0010, 0b0011, 0b0001, 0b1001};
    for (int i = 0; i < 4; i++) digitalWrite(p[i], on && (HS[phase] >> (3 - i) & 1) ? HIGH : LOW);
#else
    (void)on;
#endif
  }
  void stepOnce(int dir) {
    pos += dir;
#if DRIVER_TYPE == DRIVER_STEPDIR
    digitalWrite(p[1], (dir * dirSign) > 0 ? HIGH : LOW);
    delayMicroseconds(2);
    digitalWrite(p[0], HIGH); delayMicroseconds(3); digitalWrite(p[0], LOW);
#else
    phase = (phase + (dir * dirSign > 0 ? 1 : 7)) & 7;
    coils(true);
#endif
  }
  long stoppingSteps() const { return (long)(v * v / (2 * acc)); }
  void stopSoft() { target = pos + (v > 0 ? stoppingSteps() : -stoppingSteps()); }
  void halt() { target = pos; v = 0; }
  bool idle() const { return pos == target && v == 0; }

  void update(uint32_t now) {
    float dt = (now - lastUpdUs) * 1e-6f;
    lastUpdUs = now;
    if (dt > 0.05f) dt = 0.05f;
    long d = target - pos;
    if (d == 0 && fabsf(v) < acc * 0.01f) { v = 0; return; }
    // 目標方向へ加速、止まりきれない距離なら減速
    int want = d > 0 ? 1 : (d < 0 ? -1 : 0);
    bool mustBrake = (want == 0) || (v * want < 0) || (labs(d) <= stoppingSteps());
    if (mustBrake) {
      float dv = acc * dt;
      if (fabsf(v) <= dv) v = 0; else v -= (v > 0 ? dv : -dv);
      if (v == 0 && want != 0) v = want * fminf(acc * dt, vmax);
    } else {
      v += want * acc * dt;
      if (fabsf(v) > vmax) v = want * vmax;
    }
    if (v == 0) return;
    float interval = 1e6f / fmaxf(fabsf(v), 1.0f);
    if (now - lastStepUs >= interval) {
      lastStepUs = now;
      int dir = v > 0 ? 1 : -1;
      if ((dir > 0 && pos < target) || (dir < 0 && pos > target) || fabsf(v) > acc * 0.01f) stepOnce(dir);
    }
  }
};

Axis ax, ay;
const float SPMX = STEPS_PER_MM_X, SPMY = STEPS_PER_MM_Y;

static void drivers(bool on) {
  if (EN_PIN >= 0) digitalWrite(EN_PIN, on ? LOW : HIGH);
  if (!on) { ax.coils(false); ay.coils(false); }
}

static float clampf(float v, float a, float b) { return v < a ? a : (v > b ? b : v); }

/** mm 目標を両軸にセット。直線で動くよう軸ごとの最高速度を按分 */
static void moveToMm(float xmm, float ymm) {
  xmm = clampf(xmm, -TRAVEL_X_MM / 2, TRAVEL_X_MM / 2);
  ymm = clampf(ymm, -TRAVEL_Y_MM / 2, TRAVEL_Y_MM / 2);
  long tx = lroundf(xmm * SPMX), ty = lroundf(ymm * SPMY);
  if (tx == ax.target && ty == ay.target) return;
  float dx = fabsf((tx - ax.pos) / SPMX), dy = fabsf((ty - ay.pos) / SPMY);
  float dist = fmaxf(hypotf(dx, dy), 0.001f);
  ax.vmax = fmaxf(MAX_SPEED_MM_S * SPMX * dx / dist, 50); ay.vmax = fmaxf(MAX_SPEED_MM_S * SPMY * dy / dist, 50);
  ax.acc = fmaxf(ACCEL_MM_S2 * SPMX * dx / dist, 100);   ay.acc = fmaxf(ACCEL_MM_S2 * SPMY * dy / dist, 100);
  ax.target = tx; ay.target = ty;
}

// ===================== 原点復帰 (任意、起動時にブロッキング) =====================
#if USE_HOMING
static void homeAxis(Axis& a, int pin, float spm, float travel) {
  pinMode(pin, INPUT_PULLUP);
  uint32_t us = (uint32_t)(1e6f / (HOME_SPEED_MM_S * spm));
  uint32_t t0 = millis();
  while (digitalRead(pin) == HIGH && millis() - t0 < 30000) { a.stepOnce(-1); delayMicroseconds(us); }
  for (long i = 0; i < (long)(HOME_BACKOFF_MM * spm); i++) { a.stepOnce(1); delayMicroseconds(us); }
  a.pos = lroundf((-travel / 2 + HOME_BACKOFF_MM) * spm);  // 中央 = 0
  a.target = a.pos; a.v = 0;
}
#endif

// ===================== WebSocket =====================
WebSocketsClient ws;

static bool jsonNum(const String& s, const char* key, float& out) {
  int k = s.indexOf(key);  // key は "\"x\":" のようにクォート+コロン込み ("x_mm" と区別)
  if (k < 0) return false;
  out = s.substring(k + strlen(key)).toFloat();
  return true;
}

static void onWs(WStype_t type, uint8_t* data, size_t len) {
  switch (type) {
    case WStype_CONNECTED:    Serial.println("[ws] connected"); wsUp = true; ws.sendTXT("ping"); break;
    case WStype_DISCONNECTED: Serial.println("[ws] disconnected"); wsUp = false; break;
    case WStype_TEXT: {
      String s((const char*)data, len);
      if (s.indexOf("\"t\":\"xy\"") < 0) break;  // {"payload":...} などは無視
      float x, y;
      if (!jsonNum(s, "\"x\":", x) || !jsonNum(s, "\"y\":", y)) break;
      bool act = s.indexOf("\"active\":true") >= 0;
      bool es = s.indexOf("\"estop\":true") >= 0;
      portENTER_CRITICAL(&mux);
      tgtXmm = (X_INVERT ? -x : x) * PLAY_RADIUS_MM;
      tgtYmm = (Y_INVERT ? -y : y) * PLAY_RADIUS_MM;
      gActive = act; gEstop = es; lastMsgAt = millis();
      portEXIT_CRITICAL(&mux);
      break;
    }
    default: break;
  }
}

static void wsTask(void*) {
  WiFi.begin(WIFI_SSID, WIFI_PASS);
  Serial.print("[wifi] connecting");
  while (WiFi.status() != WL_CONNECTED) { vTaskDelay(pdMS_TO_TICKS(300)); Serial.print("."); }
  Serial.printf("\n[wifi] ip=%s\n", WiFi.localIP().toString().c_str());
  String path = String("/api/rooms/") + ROOM_CODE + "/device/ws";
  ws.beginSSL(WS_HOST, WS_PORT, path.c_str());  // 証明書検証なし (ハッカソン用)
  ws.onEvent(onWs);
  ws.setReconnectInterval(2000);
  ws.enableHeartbeat(15000, 3000, 2);
  uint32_t lastPing = 0;
  for (;;) {
    ws.loop();
    if (wsUp && millis() - lastPing > PING_MS) { lastPing = millis(); ws.sendTXT("ping"); }
    vTaskDelay(1);
  }
}

// ===================== main =====================
void setup() {
  Serial.begin(115200);
#if DRIVER_TYPE == DRIVER_STEPDIR
  ax.p[0] = X_STEP; ax.p[1] = X_DIR; ay.p[0] = Y_STEP; ay.p[1] = Y_DIR;
#else
  ax.p[0] = X_IN1; ax.p[1] = X_IN2; ax.p[2] = X_IN3; ax.p[3] = X_IN4;
  ay.p[0] = Y_IN1; ay.p[1] = Y_IN2; ay.p[2] = Y_IN3; ay.p[3] = Y_IN4;
#endif
  ax.begin(); ay.begin();
  if (EN_PIN >= 0) pinMode(EN_PIN, OUTPUT);
  drivers(true);
#if USE_HOMING
  Serial.println("[home] homing...");
  homeAxis(ax, X_HOME_PIN, SPMX, TRAVEL_X_MM);
  homeAxis(ay, Y_HOME_PIN, SPMY, TRAVEL_Y_MM);
  moveToMm(0, 0);
#endif
  ax.lastUpdUs = ay.lastUpdUs = micros();
  xTaskCreatePinnedToCore(wsTask, "ws", 8192, nullptr, 1, nullptr, 0);
}

void loop() {
  static bool driversOn = true, holding = true;
  static uint32_t lastLog = 0;
  float x, y; bool act, es; uint32_t at;
  portENTER_CRITICAL(&mux);
  x = tgtXmm; y = tgtYmm; act = gActive; es = gEstop; at = lastMsgAt;
  portEXIT_CRITICAL(&mux);
  uint32_t nowMs = millis();
  bool fresh = at != 0 && nowMs - at < FAILSAFE_MS && wsUp;

  if (es) {                       // 緊急停止: 即停止 + ドライバ OFF
    ax.halt(); ay.halt();
    if (driversOn) { drivers(false); driversOn = false; Serial.println("[estop] drivers off"); }
  } else if (!fresh || !act) {    // 通信断 / inactive: その場で減速停止して保持
    if (!holding) { ax.stopSoft(); ay.stopSoft(); holding = true; Serial.println(fresh ? "[hold] inactive" : "[failsafe] no xy -> stop"); }
  } else {
    if (!driversOn) { drivers(true); driversOn = true; }
    holding = false;
    moveToMm(x, y);
  }

  uint32_t now = micros();
  ax.update(now); ay.update(now);

#if DISABLE_WHEN_IDLE
  if (driversOn && holding && ax.idle() && ay.idle()) { drivers(false); driversOn = false; }
#endif
  if (nowMs - lastLog > 1000) {
    lastLog = nowMs;
    Serial.printf("[xy] tgt=(%.0f,%.0f)mm pos=(%.0f,%.0f)mm act=%d estop=%d fresh=%d\n", x, y, ax.pos / SPMX, ay.pos / SPMY, act, es, fresh);
  }
}
