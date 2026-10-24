// config.h にコピーして値を埋める (config.h は .gitignore 済み)。config.h が無ければこのファイルでビルドされる
#pragma once
#define WIFI_SSID     "your-ssid"
#define WIFI_PASS     "your-pass"
#define WS_HOST       "ek.ryuzu.dev"
#define WS_PORT       443
#define ROOM_CODE     "ABCD"          // /sim で作った部屋コード (PC 画面で出力モード「B 磁石XY」にする)

// ---- ドライバ種別 ----
// DRIVER_STEPDIR : A4988 / DRV8825 / TMC2208 など (STEP + DIR + EN)
// DRIVER_ULN2003 : 28BYJ-48 + ULN2003 (4 本の IN をハーフステップ駆動。遅いが安い)
#define DRIVER_STEPDIR 1
#define DRIVER_ULN2003 2
#define DRIVER_TYPE   DRIVER_STEPDIR

#if DRIVER_TYPE == DRIVER_STEPDIR
#define X_STEP 26
#define X_DIR  25
#define Y_STEP 33
#define Y_DIR  32
#define EN_PIN 27     // A4988 の EN (LOW=有効)。2 軸共通。未配線なら -1
#else
// 28BYJ-48: ULN2003 の IN1..IN4
#define X_IN1 25
#define X_IN2 26
#define X_IN3 27
#define X_IN4 14
#define Y_IN1 32
#define Y_IN2 33
#define Y_IN3 18
#define Y_IN4 19
#define EN_PIN -1
#endif
#define X_INVERT 0    // 東へ動かしたいのに西へ行くなら 1
#define Y_INVERT 0    // 南へ動かしたいのに北へ行くなら 1

// ---- 機構 ----
// STEPDIR: GT2 ベルト 20T プーリー + 1/16 マイクロステップ = 200*16/(2*20) = 80 steps/mm
// 28BYJ-48 (ハーフステップ 4096 steps/rev) + GT2 20T = 4096/40 ≒ 102.4 steps/mm
#define STEPS_PER_MM_X 80.0f
#define STEPS_PER_MM_Y 80.0f
#define PLAY_RADIUS_MM 150.0f   // サーバーの座標 1.0 (= 席の位置) を何 mm にするか
#define TRAVEL_X_MM    320.0f   // X の可動範囲 (全長)。中央 ±TRAVEL/2 を超えないようクランプ
#define TRAVEL_Y_MM    320.0f
#define MAX_SPEED_MM_S 60.0f    // まずは遅めで (磁石が外れない速度)。28BYJ なら 10〜15
#define ACCEL_MM_S2    200.0f

// ---- 原点復帰 (任意) ----
// 1 にすると起動時に -X / -Y 端のリミットスイッチ (INPUT_PULLUP, 押すと LOW) まで動いて原点を取る。
// 0 なら「電源投入時の位置 = 卓の中央」とみなす (中央に印をつけておく)
#define USE_HOMING     0
#define X_HOME_PIN     34
#define Y_HOME_PIN     35
#define HOME_SPEED_MM_S 20.0f
#define HOME_BACKOFF_MM 3.0f

// ---- 安全 ----
#define FAILSAFE_MS 1500        // これだけ xy が来なければその場で停止
#define PING_MS     500         // この間隔で "ping" を送るとサーバーが最新 xy を返す (ロビー中の TTL 切れ防止)
#define DISABLE_WHEN_IDLE 0     // 1 = 停止中はコイル OFF (28BYJ の発熱対策。保持力はなくなる)
