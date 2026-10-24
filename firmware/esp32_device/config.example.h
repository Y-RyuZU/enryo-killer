// config.h にコピーして値を埋める (config.h は .gitignore 済み)
#pragma once
#define WIFI_SSID     "your-ssid"
#define WIFI_PASS     "your-pass"
#define WS_HOST       "ek.ryuzu.dev"
#define WS_PORT       443
#define ROOM_CODE     "ABCD"          // /sim で作った部屋コード

// ---- モーター (2輪差動、TB6612FNG / L298N / DRV8833 系の IN1/IN2 + PWM) ----
// ボードとドライバが決まったらここだけ直す。PWM 不要なドライバは EN を -1 に。
#define L_IN1 25
#define L_IN2 26
#define L_EN  27   // PWM (ENA / PWMA)。-1 なら未使用
#define R_IN1 32
#define R_IN2 33
#define R_EN  14   // PWM (ENB / PWMB)。-1 なら未使用
#define STBY  -1   // TB6612 の STBY。不要なら -1
#define SPEED 200  // 0-255
#define TURN_SPEED 160

// 最後のコマンドからこの ms 何も来なければ停止 (通信断フェイルセーフ)
#define FAILSAFE_MS 1000
