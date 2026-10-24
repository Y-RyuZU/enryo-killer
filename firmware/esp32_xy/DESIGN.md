> Claude Code (claude -p) に出してもらった設計案そのまま。実装時の差分は README.md の「設計からの変更点」を参照。

# Plan B Design Doc — XY Gantry Magnet (enryo-killer)

## 0. Scope & non-goals
Plan B drives a magnet under the table along X/Y so the karaage plate follows. Fallback: a human holds the magnet and follows a web screen. Game logic (tick, tension, plate physics) is **unchanged** — Plan B only changes what we emit on the existing device WS and adds one page + one REST pair.

---

## 1. Wire protocol

**Decision: reuse `mode:"B"` for game semantics, add an orthogonal per-room `deviceMode: "wheels"|"xy"` for the transport.** Rationale: `mode` is the *game/actuator intent* already surfaced in `Snapshot` and `/sim`; `deviceMode` decides *what bytes go down the device WS*. Keeping them separate lets us test xy framing while `mode:"C"`, and avoids touching the two agents' `mode` handling. Default `deviceMode = "wheels"` → zero behavior change.

Server→device frames are **discriminated by a `t` field**, never both shapes at once:

```jsonc
// wheels (UNCHANGED — Plan A firmware only parses "payload")
{"payload":"forward"}
// xy
{"t":"xy","seq":123,"active":true,"estop":false,"ttlMs":1500,
 "x":-0.21,"y":0.63,          // target, normalized -1..1, +x=E +y=S
 "x_mm":-210,"y_mm":630,      // same point, table radius mm (convenience/log)
 "feed_mm_s":80}
```

Backward compat: Plan A firmware greps for `"payload"`, which is absent from xy frames → it ignores them (no crash, but its failsafe fires and it stops — correct). XY firmware greps `"t":"xy"` and ignores `{"payload":...}`. On a `deviceMode` switch to xy, send one final `{"payload":"stop"}` then begin xy frames; switching back sends `stop` first. Clients may connect with `?dm=xy` for logging only — the room, not the socket, owns the mode.

Target = **plate position**, not the leader seat: the plate is the authoritative sim state, so the gantry tracks it and all three modes stay visually consistent. `active:false` ⇒ hold position (do not home, do not move). `estop:true` ⇒ disable drivers.

---

## 2. Server changes (additive)

**`shared.ts`**
```ts
export type DeviceMode = "wheels" | "xy";
export const DEVICE_MODES: DeviceMode[] = ["wheels", "xy"];
export type XyPayload = { t:"xy"; seq:number; active:boolean; estop:boolean;
  ttlMs:number; x:number; y:number; x_mm:number; y_mm:number; feed_mm_s:number };
export type DeviceWsMsg = { payload: MovePayload } | XyPayload;  // widen
// Snapshot += deviceMode: DeviceMode; lastXy?: XyPayload | null;
// C2S config += deviceMode?: DeviceMode
```

**`logic.ts`** — add `xyPayload(cmd: DeviceCmd, plate: Plate): XyPayload`, derived from the existing `deviceCmd({type:"B",...})` so clamping/scaling logic isn't duplicated. `active = cmd.active`; coordinates clamped to unit disc (`r>1 ⇒ scale by 1/r`), rounded to 3 dp.

**`room.ts`**
- `autoDevice()`: branch once —
  ```ts
  if (this.s.deviceMode === "xy") {
    const cmd = deviceCmd({ type:"B", ... });
    this.sendXy(xyPayload(cmd, this.s.plate));
  } else { /* existing wheels path untouched */ }
  ```
- `sendXy(p, only?)` mirrors `sendDevice`, stores `lastXy`.
- `/device/ws` open handler: send `lastXy` or a parked `active:false` frame when `deviceMode==="xy"`, else existing `stop`.
- `{t:"config", deviceMode}` sets it + `broadcast()`.

**REST (new, in `index.ts` Hono)**
- `GET /api/rooms/:code/device/mode` → `{deviceMode, deviceOnline, lastXy}`
- `PUT /api/rooms/:code/device/mode` body `{deviceMode}` → same shape; 400 on unknown value.
- `POST /api/rooms/:code/device/xy` body `{x,y,ms?}` → manual jog: sets `manualUntil = Date.now()+ms` (reusing the wheels manual-suppression field) and sends one xy frame. Lets us drive the gantry from curl without the game running.

Swagger: three entries under tag `device`, `DeviceMode` enum schema + `XyPayload` schema, and extend the existing device docs to note the two frame shapes.

---

## 3. Web

**Host (`/sim`)** — a 2-button segmented toggle `wheels | xy` next to the existing mode selector, sending `{t:"config",deviceMode}`; reads back `snapshot.deviceMode`. Show `lastXy` as `x,y (mm)` + a stale indicator if `deviceOnline` is false.

**`/under` — human magnet.** Phone held by the person under the table, looking **up** at a screen above their face.
- Full-bleed dark canvas, one **big arrow** from current magnet position (the human's last confirmed position, see below) to the target dot, plus distance in cm in huge type.
- We can't sense the human's position, so treat the phone as "at the magnet": the arrow shows **delta from the last target** and the dot shows absolute target on a mini table circle (seat labels N/E/S/W). The person's job is simply "keep the dot centered".
- **Mirror toggle** (`scaleX(-1)`, persisted in `localStorage`) because looking up at a screen from underneath flips left/right; also a **rotate 0/90/180/270** control since they may lie in any orientation. Default mirror **on**.
- `navigator.vibrate` pulse when the required move exceeds a threshold (short pulse = move, double = stop/hold), and a red full-screen flash on `estop`. Vibration is a nice-to-have — guard for unsupported browsers.
- Wake-lock (`navigator.wakeLock`) so the screen stays on; no interactive controls in the thumb zone except the mirror/rotate chips at the top edge.

---

## 4. Firmware `firmware/esp32_xy/`

Files: `esp32_xy.ino`, `config.h`. Style matches `esp32_device.ino` (hand-rolled JSON scan, `WebSockets` by Markus Sattler, `beginSSL` without cert validation).

**`config.h`**: `WIFI_SSID/PASS`, `WS_HOST/PORT`, `ROOM_CODE`; `DRIVER_A4988` vs `DRIVER_ULN2003` (compile-time); per-axis `X_STEP/X_DIR/X_EN`, `Y_STEP/Y_DIR/Y_EN` (or four IN pins per axis for 28BYJ-48); `X_INVERT/Y_INVERT`; `STEPS_PER_MM_X/Y`; `TABLE_RADIUS_MM`; `TRAVEL_X_MM/TRAVEL_Y_MM` (rectangle the circle is inscribed in — must be ≥ 2·R per axis); `MAX_SPEED_MM_S`, `MAX_ACCEL_MM_S2`; `USE_HOMING`, `X_HOME_PIN/Y_HOME_PIN`, `HOME_FEED_MM_S`, `HOME_BACKOFF_MM`; `FAILSAFE_MS` (1500).

**Mapping**: `steps_x = (x * TABLE_RADIUS_MM) * STEPS_PER_MM_X`, likewise y; origin = table center = machine center (`TRAVEL/2` after homing). Clamp to `±TRAVEL/2` per axis **and** to the unit disc so a bad frame can't crash into a rail.

**Motion**: use **AccelStepper + MultiStepper** when the core is available (`#include <AccelStepper.h>`); it gives non-blocking `run()` with accel and coordinated 2-axis moves for free. Hand-rolled fallback is a `micros()`-based step pulse per axis in `loop()` with a trapezoidal ramp — keep AccelStepper as the default to save hackathon time. `loop()` is `ws.loop(); stepper.run(); failsafe();` — **never block**, no `delay()` in the motion path. 28BYJ-48 variant: `AccelStepper(HALF4WIRE, in1,in3,in2,in4)`, `MAX_SPEED_MM_S` ~an order of magnitude lower; half-stepping is required for reasonable torque.

**Homing** (optional, `USE_HOMING`): seek −X to switch, back off, zero; same for Y; then move to center. Without switches, power-on position is assumed center (mark the table).

**Failsafe / estop**: no xy frame for `FAILSAFE_MS`, or WS disconnect, or `active:false` ⇒ `stepper.stop()` (decelerate, hold). `estop:true` ⇒ stop **and** drive `EN` high (drivers disabled, magnet coasts). Recover only on a fresh `estop:false` frame.

---

## 5. Test plan & risks

| Step | How |
|---|---|
| Protocol | `curl PUT .../device/mode {"deviceMode":"xy"}`, then `wscat` as device — assert xy frames at 2 Hz, `active:false` while in lobby |
| Regression | With `deviceMode:"wheels"`, confirm byte-identical `{"payload":...}` stream (protects the other agents' work) |
| Mapping | `POST /device/xy` with the 5 points (0,0), (±1,0), (0,±1) → measure magnet travel, tune `STEPS_PER_MM` |
| Motion | Full-speed diagonal; watch for skipped steps / lost position over 20 cycles |
| Failsafe | Kill the WS mid-move → stops within `FAILSAFE_MS`; estop from `/sim` → drivers disabled |
| Human magnet | `/under` on a phone taped under the table, run a full game, check mirror orientation with a real person |

**Risks.** (1) Magnet coupling: too weak and the plate slips, too strong and it drags the tablecloth — budget time for magnet/gap tuning and cap `MAX_SPEED_MM_S` low (start ~60 mm/s). (2) Open-loop steppers drift with no homing — re-center between rounds. (3) Gantry build time is the real schedule risk, hence the human-magnet page as a demo-day guarantee: it exercises the identical server path, so Plan B is demoable even with zero hardware. (4) Table rectangle smaller than 2R per axis clips the corners of play — verify `TRAVEL ≥ 2R` before the demo.
