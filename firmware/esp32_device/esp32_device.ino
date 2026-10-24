// enryo-killer ESP32 device firmware
// wss://<WS_HOST>/api/rooms/<ROOM_CODE>/device/ws に繋ぎ、{"payload":"forward"} 等を受けてモーターを動かす。
// 必要ライブラリ: "WebSockets" by Markus Sattler (Arduino Library Manager)
#include <WiFi.h>
#include <WebSocketsClient.h>
#if __has_include("config.h")
#include "config.h"
#else
#include "config.example.h"
#endif

WebSocketsClient ws;
unsigned long lastCmdAt = 0;
String current = "stop";

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

static void drive(const String& p) {
  if (p == "forward")         { motor(L_IN1, L_IN2, L_EN,  1, SPEED);      motor(R_IN1, R_IN2, R_EN,  1, SPEED); }
  else if (p == "backward")   { motor(L_IN1, L_IN2, L_EN, -1, SPEED);      motor(R_IN1, R_IN2, R_EN, -1, SPEED); }
  else if (p == "turn_right") { motor(L_IN1, L_IN2, L_EN,  1, TURN_SPEED); motor(R_IN1, R_IN2, R_EN, -1, TURN_SPEED); }
  else if (p == "turn_left")  { motor(L_IN1, L_IN2, L_EN, -1, TURN_SPEED); motor(R_IN1, R_IN2, R_EN,  1, TURN_SPEED); }
  else                        { motor(L_IN1, L_IN2, L_EN,  0, 0);          motor(R_IN1, R_IN2, R_EN,  0, 0); }
  if (p != current) { Serial.printf("[cmd] %s\n", p.c_str()); current = p; }
}

static void onWs(WStype_t type, uint8_t* data, size_t len) {
  switch (type) {
    case WStype_CONNECTED:    Serial.println("[ws] connected"); break;
    case WStype_DISCONNECTED: Serial.println("[ws] disconnected"); drive("stop"); break;
    case WStype_TEXT: {
      // {"payload":"forward"} から値を抜く (ArduinoJson 不要)
      String s((const char*)data, len);
      int k = s.indexOf("\"payload\"");
      if (k < 0) break;
      int a = s.indexOf('"', s.indexOf(':', k) + 1), b = s.indexOf('"', a + 1);
      if (a < 0 || b < 0) break;
      lastCmdAt = millis();
      drive(s.substring(a + 1, b));
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
  if (current != "stop" && millis() - lastCmdAt > FAILSAFE_MS) drive("stop");
}
