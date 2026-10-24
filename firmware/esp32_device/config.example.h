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
#define SPEED 200  // 0-255 (speed 省略時 = これ)
#define TURN_SPEED 160
// サーバーから speed (0..1) が来たら SPEED/TURN_SPEED に掛ける。その時の下限 duty (これ未満だと回らない)
#define MIN_DUTY 80
#define TURN_MIN_DUTY 90
#define ALLOW_SPEED_FIELD 1  // 0 で speed を無視 (常に SPEED/TURN_SPEED)

// 最後のコマンドからこの ms 何も来なければ停止 (通信断フェイルセーフ)
#define FAILSAFE_MS 1000

// ---- IMU (任意): MPU6050 / MPU6500 / MPU9250 を I2C 生レジスタで読む (追加ライブラリ不要) ----
// 1 にすると実測方位をサーバーへ送り、サーバーの方位推定を補正する。0 なら従来と完全に同じ動作
#define USE_IMU 0
#define IMU_SDA 21
#define IMU_SCL 22
#define IMU_ADDR 0x68          // AD0=HIGH なら 0x69
#define IMU_YAW_SIGN -1        // 上から見て右回り(時計回り)で yaw が増えなければ 1 に変える (HANDOFF 参照)
#define IMU_CALIB_MS 2000      // 起動時のジャイロバイアス計測 (この間は動かさない)
#define IMU_DEADBAND_DPS 0.6f  // これ未満の角速度は 0 扱い (静止ドリフト対策)
#define IMU_REPORT_MS 150      // 走行中の報告間隔
#define IMU_IDLE_REPORT_MS 1000 // stop 中の報告間隔
