// enryo-killer ESP32 device firmware
// wss://<WS_HOST>/api/rooms/<ROOM_CODE>/device/ws に繋ぎ、{"payload":"forward","speed":0.6} 等を受けてモーターを動かす。
// USE_IMU=1 なら MPU6050 の yaw をサーバーへ報告 ({"t":"imu",...}) し、旋回キャリブ ({"cmd":"calib"}) にも応答する。
// 必要ライブラリ: "WebSockets" by Markus Sattler (Arduino Library Manager)。IMU は Wire のみ (追加ライブラリ不要)
#include <WiFi.h>
#include <WebSocketsClient.h>
#if __has_include("config.h")
#include "config.h"
#else
#include "config.example.h"
#endif

// ---- 古い config.h でもビルドできるように既定値 ----
#ifndef MIN_DUTY
#define MIN_DUTY 80
#endif
#ifndef TURN_MIN_DUTY
#define TURN_MIN_DUTY 90
#endif
#ifndef ALLOW_SPEED_FIELD
#define ALLOW_SPEED_FIELD 1
#endif
#ifndef USE_IMU
#define USE_IMU 0
#endif
#ifndef IMU_SDA
#define IMU_SDA 21
#endif
#ifndef IMU_SCL
#define IMU_SCL 22
#endif
#ifndef IMU_ADDR
#define IMU_ADDR 0x68
#endif
#ifndef IMU_YAW_SIGN
#define IMU_YAW_SIGN -1
#endif
#ifndef IMU_CALIB_MS
#define IMU_CALIB_MS 2000
#endif
#ifndef IMU_DEADBAND_DPS
#define IMU_DEADBAND_DPS 0.6f
#endif
#ifndef IMU_REPORT_MS
#define IMU_REPORT_MS 150
#endif
#ifndef IMU_IDLE_REPORT_MS
#define IMU_IDLE_REPORT_MS 1000
#endif
#define FW_VERSION "1.1.0"

WebSocketsClient ws;
unsigned long lastCmdAt = 0;
String current = "stop";
float currentSpeed = 1.0f;

static void pwmSetup(int pin) {
  if (pin < 0) return;
#if ESP_ARDUINO_VERSION_MAJOR >= 3
  ledcAttach(pin, 20000, 8);
#else
  static int ch = 0; ledcSetup(ch, 20000, 8); ledcAttachPin(pin, ch); ch++;
#endif
}
static void pwmWrite(int pin, int duty) {
  if (pin < 0) return;
#if ESP_ARDUINO_VERSION_MAJOR >= 3
  ledcWrite(pin, duty);
#else
  ledcWrite(pin == L_EN ? 0 : 1, duty);
#endif
}

// dir: 1=前, -1=後, 0=停止
static void motor(int in1, int in2, int en, int dir, int speed) {
  digitalWrite(in1, dir > 0 ? HIGH : LOW);
  digitalWrite(in2, dir < 0 ? HIGH : LOW);
  pwmWrite(en, dir == 0 ? 0 : speed);
}

// sp: 0..1 (SPEED/TURN_SPEED への倍率)。1.0 = 従来と完全に同じ duty
static void drive(const String& p, float sp = 1.0f) {
  int fwdDuty = SPEED, turnDuty = TURN_SPEED;
  if (sp < 0.999f) {  // 明示指定のときだけ倍率 + 下限
    fwdDuty = constrain((int)lroundf(SPEED * sp), MIN_DUTY, 255);
    turnDuty = constrain((int)lroundf(TURN_SPEED * sp), TURN_MIN_DUTY, 255);
  }
  if (p == "forward")         { motor(L_IN1, L_IN2, L_EN,  1, fwdDuty);  motor(R_IN1, R_IN2, R_EN,  1, fwdDuty); }
  else if (p == "backward")   { motor(L_IN1, L_IN2, L_EN, -1, fwdDuty);  motor(R_IN1, R_IN2, R_EN, -1, fwdDuty); }
  else if (p == "turn_right") { motor(L_IN1, L_IN2, L_EN,  1, turnDuty); motor(R_IN1, R_IN2, R_EN, -1, turnDuty); }
  else if (p == "turn_left")  { motor(L_IN1, L_IN2, L_EN, -1, turnDuty); motor(R_IN1, R_IN2, R_EN,  1, turnDuty); }
  else                        { motor(L_IN1, L_IN2, L_EN,  0, 0);        motor(R_IN1, R_IN2, R_EN,  0, 0); }
  if (p != current || fabsf(sp - currentSpeed) > 0.02f) {
    if (sp < 0.999f) Serial.printf("[cmd] %s @%.2f\n", p.c_str(), sp);
    else Serial.printf("[cmd] %s\n", p.c_str());
    current = p; currentSpeed = sp;
  }
}

// "key":"value" の value 範囲 [a,b) を返す
static bool strField(const String& s, const char* key, int* a, int* b) {
  int k = s.indexOf(String("\"") + key + "\"");
  if (k < 0) return false;
  int c = s.indexOf(':', k);
  if (c < 0) return false;
  int x = s.indexOf('"', c + 1);
  if (x < 0) return false;
  int y = s.indexOf('"', x + 1);
  if (y < 0) return false;
  *a = x + 1; *b = y;
  return true;
}
// "key":<number>
static bool numField(const String& s, const char* key, float* out) {
  int k = s.indexOf(String("\"") + key + "\"");
  if (k < 0) return false;
  int c = s.indexOf(':', k);
  if (c < 0) return false;
  *out = s.substring(c + 1).toFloat();
  return true;
}

// ================= IMU =================
#if USE_IMU
#include <Wire.h>
static bool imuOk = false;
static float gBiasRaw = 0;       // ジャイロ Z のバイアス (raw)
static float yawDeg = 0;         // 0..360 (報告用)
static float yawRawDeg = 0;      // wrap しない積算 (キャリブ計測用)
static float lastRateDps = 0;
static unsigned long yawLastUs = 0, reportAt = 0;
static int imuFails = 0;
static uint32_t bootId = 0;
static volatile unsigned long calibUntil = 0;  // キャリブ旋回中はフェイルセーフを抑止
static const float GYRO_LSB_PER_DPS = 65.5f;   // ±500dps
// WS コールバック内で ws.loop() を回すと再入になるので、calib 指示は loop() で実行する
struct PendingCalib { bool on; int id; bool right; int ms; float sp; };
static PendingCalib pendingCalib = {false, 0, true, 2000, 1.0f};

static void imuWr(uint8_t reg, uint8_t v) {
  Wire.beginTransmission(IMU_ADDR); Wire.write(reg); Wire.write(v); Wire.endTransmission();
}
static bool imuRd(uint8_t reg, uint8_t* buf, size_t n) {
  Wire.beginTransmission(IMU_ADDR); Wire.write(reg);
  if (Wire.endTransmission(false) != 0) return false;
  if (Wire.requestFrom((int)IMU_ADDR, (int)n) != (int)n) return false;
  for (size_t i = 0; i < n; i++) buf[i] = Wire.read();
  return true;
}
static bool imuRawZ(int16_t* z) {
  uint8_t b[2];
  if (!imuRd(0x47, b, 2)) return false;  // GYRO_ZOUT_H/L
  *z = (int16_t)((b[0] << 8) | b[1]);
  return true;
}
static bool imuInit() {
  Wire.begin(IMU_SDA, IMU_SCL);
  Wire.setClock(400000);
  uint8_t who = 0;
  if (!imuRd(0x75, &who, 1)) { Serial.println("[imu] not found (I2C)"); return false; }
  if (who != 0x68 && who != 0x70 && who != 0x71 && who != 0x73 && who != 0x19 && who != 0x98) {
    Serial.printf("[imu] unknown WHO_AM_I=0x%02X\n", who); return false;
  }
  imuWr(0x6B, 0x80); delay(100);  // reset
  imuWr(0x6B, 0x01); delay(50);   // wake, PLL clock
  imuWr(0x19, 0x07);              // 125Hz
  imuWr(0x1A, 0x03);              // DLPF ~44Hz (モーター振動対策)
  imuWr(0x1B, 0x08);              // ±500 dps
  Serial.printf("[imu] ok WHO_AM_I=0x%02X\n", who);
  return true;
}
// 起動時: 静止状態で IMU_CALIB_MS 平均 → バイアス
static void imuCalibrateBias() {
  for (int attempt = 0; attempt < 2; attempt++) {
    long n = 0; double sum = 0; int16_t mn = 32767, mx = -32768, z;
    unsigned long t0 = millis();
    while (millis() - t0 < IMU_CALIB_MS) {
      if (imuRawZ(&z)) { sum += z; n++; if (z < mn) mn = z; if (z > mx) mx = z; }
      delay(2);
    }
    if (n == 0) { imuOk = false; Serial.println("[imu] read failed"); return; }
    gBiasRaw = sum / n;
    float spread = (mx - mn) / GYRO_LSB_PER_DPS;
    Serial.printf("[imu] bias=%.2f dps spread=%.1f dps (n=%ld)\n", gBiasRaw / GYRO_LSB_PER_DPS, spread, n);
    if (spread < 5) return;
    Serial.println("[imu] !!! 動いてる? バイアス計測やり直し (起動直後は触らないで)");
  }
}
static void imuUpdate() {
  unsigned long us = micros();
  float dt = (us - yawLastUs) / 1e6f;
  yawLastUs = us;
  if (dt <= 0 || dt > 0.2f) return;  // 初回 / 長いブロック後は捨てる
  int16_t z;
  if (!imuRawZ(&z)) {
    if (++imuFails > 50) { imuOk = false; Serial.println("[imu] too many read errors -> disabled"); }
    return;
  }
  imuFails = 0;
  float r = IMU_YAW_SIGN * (z - gBiasRaw) / GYRO_LSB_PER_DPS;  // 時計回り = +
  if (fabsf(r) < IMU_DEADBAND_DPS) r = 0;
  lastRateDps = r;
  yawRawDeg += r * dt;
  yawDeg += r * dt;
  while (yawDeg >= 360) yawDeg -= 360;
  while (yawDeg < 0) yawDeg += 360;
}
static void sendHello() {
  char b[128];
  snprintf(b, sizeof b, "{\"t\":\"hello\",\"fw\":\"%s\",\"imu\":%d,\"boot\":%lu,\"speedMax\":%d,\"turnMax\":%d}",
           FW_VERSION, imuOk ? 1 : 0, (unsigned long)bootId, SPEED, TURN_SPEED);
  ws.sendTXT(b);
}
static void imuReport(bool force = false) {
  if (!imuOk || !ws.isConnected()) return;
  unsigned long now = millis();
  unsigned long period = (current == "stop" && !calibUntil) ? IMU_IDLE_REPORT_MS : IMU_REPORT_MS;
  if (!force && now - reportAt < period) return;
  reportAt = now;
  char b[96];
  snprintf(b, sizeof b, "{\"t\":\"imu\",\"yaw\":%.1f,\"gz\":%.1f,\"ms\":%lu}", yawDeg, lastRateDps, now);
  ws.sendTXT(b);
}
// 旋回キャリブ: ms だけその場旋回し、実測 deg/s を返す (ws.loop は回し続ける。stop を受けたら中断)
static void imuCalibSpin(int id, bool right, int ms, float sp) {
  if (calibUntil) return;  // 二重起動しない
  float y0 = yawRawDeg;
  unsigned long t0 = millis();
  calibUntil = t0 + ms;
  Serial.printf("[calib] spin %s %dms @%.2f\n", right ? "right" : "left", ms, sp);
  drive(right ? "turn_right" : "turn_left", sp);
  while (calibUntil && (long)(millis() - calibUntil) < 0) { ws.loop(); if (imuOk) imuUpdate(); imuReport(); delay(1); }
  bool aborted = calibUntil == 0;
  unsigned long el = millis() - t0;
  calibUntil = 0;
  drive("stop");
  delay(300);  // 惰性で回る分も計測に含める
  unsigned long t1 = millis();
  while (millis() - t1 < 300) { ws.loop(); if (imuOk) imuUpdate(); delay(1); }
  lastCmdAt = millis();
  float deg = yawRawDeg - y0;
  float dps = fabsf(deg) / (el / 1000.0f);
  char b[160];
  bool ok = imuOk && !aborted;
  snprintf(b, sizeof b, "{\"t\":\"calib\",\"id\":%d,\"dir\":\"%s\",\"ms\":%lu,\"deg\":%.1f,\"dps\":%.1f,\"ok\":%d%s}",
           id, right ? "right" : "left", el, deg, dps, ok ? 1 : 0, ok ? "" : (aborted ? ",\"err\":\"aborted\"" : ",\"err\":\"imu\""));
  ws.sendTXT(b);
  Serial.printf("[calib] %.1f deg in %lums -> %.1f deg/s%s\n", deg, el, dps, aborted ? " (aborted)" : "");
}
#endif

static void onWs(WStype_t type, uint8_t* data, size_t len) {
  switch (type) {
    case WStype_CONNECTED:
      Serial.println("[ws] connected");
#if USE_IMU
      sendHello();
#endif
      break;
    case WStype_DISCONNECTED:
      Serial.println("[ws] disconnected");
#if USE_IMU
      calibUntil = 0;
      pendingCalib.on = false;
#endif
      drive("stop");
      break;
    case WStype_TEXT: {
      // {"payload":"forward","speed":0.6} から値を抜く (ArduinoJson 不要)
      String s((const char*)data, len);
      int a, b;
      if (s.indexOf("\"payload\"") >= 0) {
        if (!strField(s, "payload", &a, &b)) break;
        String p = s.substring(a, b);
        float sp = 1.0f;
#if ALLOW_SPEED_FIELD
        float v;
        if (numField(s, "speed", &v)) sp = v < 0 ? 0 : (v > 1 ? 1 : v);
#endif
#if USE_IMU
        if (calibUntil) {  // キャリブ中は stop だけ受け付けて中断
          if (p == "stop") calibUntil = 0;
          break;
        }
#endif
        lastCmdAt = millis();
        drive(p, sp);
        break;
      }
#if USE_IMU
      if (strField(s, "cmd", &a, &b) && s.substring(a, b) == "calib") {
        float id = 0, ms = 2000, sp = 1;
        numField(s, "id", &id); numField(s, "ms", &ms); numField(s, "speed", &sp);
        bool right = !(strField(s, "dir", &a, &b) && s.substring(a, b) == "left");
        if (!calibUntil) pendingCalib = {true, (int)id, right, (int)constrain(ms, 300.0f, 5000.0f), constrain(sp, 0.2f, 1.0f)};
      }
#endif
      break;
    }
    default: break;
  }
}

void setup() {
  Serial.begin(115200);
  for (int p : {L_IN1, L_IN2, R_IN1, R_IN2}) pinMode(p, OUTPUT);
  if (STBY >= 0) { pinMode(STBY, OUTPUT); digitalWrite(STBY, HIGH); }
  pwmSetup(L_EN); pwmSetup(R_EN);
  drive("stop");

#if USE_IMU
  bootId = esp_random();
  imuOk = imuInit();
  if (imuOk) { Serial.println("[imu] バイアス計測中… 動かさないで"); imuCalibrateBias(); }
  yawLastUs = micros();
#endif

  WiFi.begin(WIFI_SSID, WIFI_PASS);
  Serial.print("[wifi] connecting");
  while (WiFi.status() != WL_CONNECTED) { delay(300); Serial.print("."); }
  Serial.printf("\n[wifi] ip=%s\n", WiFi.localIP().toString().c_str());

  String path = String("/api/rooms/") + ROOM_CODE + "/device/ws";
  ws.beginSSL(WS_HOST, WS_PORT, path.c_str());  // 証明書検証なし (ハッカソン用)
  ws.onEvent(onWs);
  ws.setReconnectInterval(2000);
  ws.enableHeartbeat(15000, 3000, 2);
}

void loop() {
  ws.loop();
#if USE_IMU
  if (imuOk) { imuUpdate(); imuReport(); }
  if (pendingCalib.on) {
    PendingCalib c = pendingCalib;
    pendingCalib.on = false;
    imuCalibSpin(c.id, c.right, c.ms, c.sp);  // ブロッキング (中で ws.loop を回す)
  }
#endif
  if (current != "stop" && millis() - lastCmdAt > FAILSAFE_MS) drive("stop");
}
