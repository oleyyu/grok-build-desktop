// gbd-input: one CGEvent action per invocation. Coords are logical points.
// Denied CGEventPost is a silent no-op — preflight Accessibility first.
//   gbd-input move  <x> <y>
//   gbd-input click <x> <y> [left|right|middle] [count]
//   gbd-input down  <x> <y> [left|right|middle]
//   gbd-input up    <x> <y> [left|right|middle]
//   gbd-input drag  <x1> <y1> <x2> <y2> [left|right|middle] [steps]

import Foundation
import CoreGraphics
import AppKit
import ScreenCaptureKit
import ImageIO
import ApplicationServices


func fail(_ code: Int32, _ msg: String) -> Never {
    FileHandle.standardError.write(("{\"ok\":false,\"error\":\"" +
        msg.replacingOccurrences(of: "\"", with: "'") + "\"}\n").data(using: .utf8)!)
    exit(code)
}

func ok(_ extra: String = "") {
    let body = extra.isEmpty ? "" : "," + extra
    FileHandle.standardOutput.write(("{\"ok\":true" + body + "}\n").data(using: .utf8)!)
    exit(0)
}

var typedScalars = 0
let PROGRESS_EVERY = 100

func writeStderrRaw(_ s: String) {
    s.withCString { p in _ = write(2, p, strlen(p)) }
}

func reportTypedAndExit(_ code: Int32) -> Never {
    writeStderrRaw("{\"ok\":false,\"error\":\"interrupted (killed before finishing)\",\"typed\":\(typedScalars)}\n")
    _exit(code)
}

let args = Array(CommandLine.arguments.dropFirst())
guard let cmd = args.first else { fail(3, "no command") }

func dbl(_ i: Int, _ name: String) -> Double {
    guard i < args.count, let v = Double(args[i]) else { fail(3, "missing/invalid \(name)") }
    return v
}
func str(_ i: Int) -> String? { i < args.count ? args[i] : nil }

func optValue(_ name: String) -> String? {
    if let i = args.firstIndex(of: name), i + 1 < args.count { return args[i + 1] }
    return nil
}

func jsonStr(_ s: String) -> String {
    let d = (try? JSONSerialization.data(withJSONObject: [s])) ?? Data("[\"?\"]".utf8)
    let t = String(data: d, encoding: .utf8) ?? "[\"?\"]"
    return String(t.dropFirst().dropLast())
}

// --pid <n>：ghost 模式。事件用 CGEventPostToPid 直接投给目标进程——
// 不 warp 光标、不经 HID tap，真鼠标完全不受影响，目标 App 在后台/别的 Space 也照收。
let targetPid: pid_t? = optValue("--pid").flatMap { Int32($0) }
// --winnum：目标窗口号（== CGWindowID）。postToPid 绕开了窗口服务器的命中测试，
// AppKit 要靠这两个字段才知道事件该给哪个窗口——不设的话后台窗口收不到鼠标事件。
let targetWinNum: Int64? = optValue("--winnum").flatMap { Int64($0) }
// ax 子命令把 --winnum 当「窗口身份」用：命中的元素必须属于这个 CGWindowID 的窗口。
// 同一个 App 的另一个窗口也算没命中——那说明坐标是上一张截图的，已经过期。
let targetWid: CGWindowID? = targetWinNum.flatMap { $0 > 0 ? CGWindowID($0) : nil }

// MARK: - 后台窗口的鼠标投递
//
// 把合成鼠标事件送进**别的进程**的窗口，光靠 postToPid + 91/92 两个字段是不够的：
// 事件到得了进程，但 AppKit 认不出该给哪个窗口（NSEvent.windowNumber=0）就直接丢掉。
// 本机实测（Darwin 27，自建 AppKit harness，目标全程在后台）：
//   仅 91/92                → 按钮没反应
//   加 51(windowNumber)     → 仍然没反应
//   完整配方（下面这套）     → 按钮真的按下了
// 完整配方 = 窗口本地坐标(CGEventSetWindowLocation) + 51/91/92 窗口路由 + 40 目标 pid
//          + 7 subtype + 58 手势组 + 先发一个 mouseMoved 唤醒窗口的命中跟踪态。
// 私有符号取不到就退回旧的两字段写法（顶多是投不进后台窗口，不会崩）。
// 出处：trycua/cua 的 cua-driver（MIT），字段编号与时序按本机实测复核过。

typealias GBDPostToPidFn = @convention(c) (pid_t, UnsafeMutableRawPointer) -> Void
typealias GBDSetIntFieldFn = @convention(c) (UnsafeMutableRawPointer, UInt32, Int64) -> Void
typealias GBDSetWinLocFn = @convention(c) (UnsafeMutableRawPointer, Double, Double) -> Void

func gbdSym(_ n: String) -> UnsafeMutableRawPointer? {
    dlsym(UnsafeMutableRawPointer(bitPattern: -2), n)
}
let skylightHandle = dlopen("/System/Library/PrivateFrameworks/SkyLight.framework/SkyLight", RTLD_NOW)
// Swift 的 CGEventField 是有限枚举，51/58/40 这些取不到；直接拿 C 函数按编号写。
let cgSetIntField: GBDSetIntFieldFn? = (gbdSym("CGEventSetIntegerValueField")
    ?? gbdSym("SLEventSetIntegerValueField")).map { unsafeBitCast($0, to: GBDSetIntFieldFn.self) }
let cgSetWindowLocation: GBDSetWinLocFn? = gbdSym("CGEventSetWindowLocation")
    .map { unsafeBitCast($0, to: GBDSetWinLocFn.self) }
let slEventPostToPid: GBDPostToPidFn? = gbdSym("SLEventPostToPid")
    .map { unsafeBitCast($0, to: GBDPostToPidFn.self) }

/// 完整配方可用（能写任意字段 + 能打窗口本地坐标）
let canRouteToWindow = cgSetIntField != nil && cgSetWindowLocation != nil

func setField(_ e: CGEvent, _ field: UInt32, _ value: Int64) {
    if let fn = cgSetIntField { fn(Unmanaged.passUnretained(e).toOpaque(), field, value) }
    else if let f = CGEventField(rawValue: field) { e.setIntegerValueField(f, value: value) }
}

/// 目标窗口在屏幕上的原点：窗口本地坐标 = 全局点 − 原点
func windowOrigin(_ wid: CGWindowID) -> CGPoint? {
    guard let list = CGWindowListCopyWindowInfo([.optionAll, .excludeDesktopElements],
                                                kCGNullWindowID) as? [[String: Any]] else { return nil }
    for info in list {
        guard (info[kCGWindowNumber as String] as? NSNumber)?.uint32Value == wid,
              let b = info[kCGWindowBounds as String] as? [String: Any],
              let x = b["X"] as? Double, let y = b["Y"] as? Double else { continue }
        return CGPoint(x: x, y: y)
    }
    return nil
}
let targetWindowOrigin: CGPoint? = targetWid.flatMap { windowOrigin($0) }

// 同一次手势（move→down→up、down→拖→up）的所有事件共用一个组号，
// 窗口服务器和 Chromium 才会把它们当成一串而不是各自独立的事件。
let gestureGroup = Int64(DispatchTime.now().uptimeNanoseconds % 1_000_000_000)

/// 给投给别的进程的鼠标事件盖上路由信息。phase: 2=移动 3=按下/松开的实际动作
func stampForTarget(_ e: CGEvent, at pt: CGPoint, clickState: Int64, button: Int64, phase: Int64) {
    guard let p = targetPid else { return }
    setField(e, 0, phase)
    setField(e, 1, clickState)
    setField(e, 3, button)
    setField(e, 7, 3)                      // NSEventSubtypeTouch：AppKit 认这个才当真实输入
    setField(e, 40, Int64(p))              // Chromium 的合成事件过滤器要对上目标 pid
    if let w = targetWinNum {
        setField(e, 51, w)                 // NSEvent.windowNumber —— 少了这个 AppKit 无从路由
        setField(e, 91, w)
        setField(e, 92, w)
    }
    setField(e, 58, gestureGroup)
    if let o = targetWindowOrigin, let fn = cgSetWindowLocation {
        fn(Unmanaged.passUnretained(e).toOpaque(), pt.x - o.x, pt.y - o.y)
    }
}

func mouseButton(_ s: String?) -> (CGMouseButton, CGEventType, CGEventType) {
    switch (s ?? "left").lowercased() {
    case "right":  return (.right, .rightMouseDown, .rightMouseUp)
    case "middle": return (.center, .otherMouseDown, .otherMouseUp)
    default:       return (.left, .leftMouseDown, .leftMouseUp)
    }
}
func buttonNumber(_ s: String?) -> Int64 {
    switch (s ?? "left").lowercased() {
    case "right":  return 1
    case "middle": return 2
    default:       return 0
    }
}

let src = CGEventSource(stateID: .combinedSessionState)

// SkyLight 与公有 API 是两条各自独立的投递路径。参考实现两条都发（谁认谁收），
// 但本机实测 AppKit **两条都会收到**——目标那边每次点击变成两次、拖拽事件整体翻倍。
// 所以只能二选一：默认公有 API（已验证能进后台 AppKit 窗口），
// --skylight 留给公有 API 送不到的目标（Catalyst 一类）。
let useSkylightPost = args.contains("--skylight")
func post(_ e: CGEvent?) {
    guard let e else { return }
    if let p = targetPid {
        if useSkylightPost, let fn = slEventPostToPid {
            fn(p, Unmanaged.passUnretained(e).toOpaque())
        } else {
            e.postToPid(p)
        }
    } else {
        e.post(tap: .cghidEventTap)
    }
}

/// 后台窗口要先收到一个移动事件，才会把命中跟踪态更新到目标点；
/// 直接发 down 的话 AppKit 常常当它落在窗口外而丢弃。
func primeTarget(_ pt: CGPoint) {
    guard targetPid != nil, canRouteToWindow else { return }
    if let m = CGEvent(mouseEventSource: src, mouseType: .mouseMoved,
                       mouseCursorPosition: pt, mouseButton: .left) {
        stampForTarget(m, at: pt, clickState: 0, button: 0, phase: 2)
        post(m)
        usleep(15_000)
    }
}

/// ghost 模式不许动真光标
func warp(_ pt: CGPoint) {
    if targetPid == nil { CGWarpMouseCursorPosition(pt) }
}

func requirePostAccess() {
    if !CGPreflightPostEventAccess() {
        _ = CGRequestPostEventAccess()
        fail(2, "accessibility permission not granted (CGEventPost would be a silent no-op)")
    }
}

// MARK: - Spaces（SkyLight 私有 API，dlsym 拿不到就当不可用，不许 crash）

typealias GBDMainConnFn = @convention(c) () -> Int32
typealias GBDActiveSpaceFn = @convention(c) (Int32) -> UInt64
typealias GBDCopySpacesFn = @convention(c) (Int32) -> Unmanaged<CFArray>?

struct SpacesApi {
    let activeSpace: () -> UInt64
    let copyDisplays: () -> [[String: Any]]?
}

func loadSpacesApi() -> SpacesApi? {
    guard let h = dlopen("/System/Library/PrivateFrameworks/SkyLight.framework/SkyLight", RTLD_NOW),
          let pMain = dlsym(h, "CGSMainConnectionID"),
          let pActive = dlsym(h, "CGSGetActiveSpace"),
          let pCopy = dlsym(h, "CGSCopyManagedDisplaySpaces")
    else { return nil }
    let cid = unsafeBitCast(pMain, to: GBDMainConnFn.self)()
    let activeFn = unsafeBitCast(pActive, to: GBDActiveSpaceFn.self)
    let copyFn = unsafeBitCast(pCopy, to: GBDCopySpacesFn.self)
    return SpacesApi(
        activeSpace: { activeFn(cid) },
        copyDisplays: { copyFn(cid)?.takeRetainedValue() as? [[String: Any]] }
    )
}


if cmd == "caps" {
    let post = CGPreflightPostEventAccess()
    let ax = AXIsProcessTrusted()
    var displays = [String]()
    let maxCount: UInt32 = 16
    var ids = [CGDirectDisplayID](repeating: 0, count: Int(maxCount))
    var count: UInt32 = 0
    if CGGetActiveDisplayList(maxCount, &ids, &count) == .success {
        for i in 0..<Int(count) {
            let d = ids[i]
            let bounds = CGDisplayBounds(d)
            let pw = CGDisplayPixelsWide(d)
            let ph = CGDisplayPixelsHigh(d)
            let mode = CGDisplayCopyDisplayMode(d)
            let modePixelW = mode?.pixelWidth ?? pw
            let ptW = Int(bounds.width)
            let scale = ptW > 0 ? Double(modePixelW) / Double(ptW) : 1.0
            let main = (d == CGMainDisplayID()) ? "true" : "false"
            displays.append("""
            {"id":\(d),"main":\(main),"pointsW":\(Int(bounds.width)),"pointsH":\(Int(bounds.height)),\
            "pixelsW":\(modePixelW),"pixelsH":\(mode?.pixelHeight ?? ph),"scale":\(scale),\
            "originX":\(Int(bounds.origin.x)),"originY":\(Int(bounds.origin.y))}
            """)
        }
    }
    let json = "{\"ok\":true,\"postEventAccess\":\(post),\"axTrusted\":\(ax),\"displays\":[\(displays.joined(separator: ","))]}"
    FileHandle.standardOutput.write((json + "\n").data(using: .utf8)!)
    exit(0)
}

// order = 主显示器桌面条从左到右（含全屏 space，type 4），即 ⌃←/⌃→ 的步进顺序
if cmd == "spaces" {
    guard let api = loadSpacesApi() else { fail(4, "spaces api unavailable (SkyLight private symbols missing)") }
    let active = api.activeSpace()
    var userCount = 0
    var order = [UInt64]()
    if let displays = api.copyDisplays(), let main = displays.first {
        for sp in (main["Spaces"] as? [[String: Any]]) ?? [] {
            guard let id = (sp["id64"] as? NSNumber)?.uint64Value else { continue }
            order.append(id)
            if ((sp["type"] as? NSNumber)?.intValue ?? 0) == 0 { userCount += 1 }
        }
    }
    let orderStr = order.map(String.init).joined(separator: ",")
    ok("\"active\":\(active),\"userCount\":\(userCount),\"order\":[\(orderStr)]")
}


if cmd == "move" {
    let x = dbl(1, "x"), y = dbl(2, "y")
    let pt = CGPoint(x: x, y: y)
    warp(pt)
    if targetPid != nil || CGPreflightPostEventAccess() {
        let e = CGEvent(mouseEventSource: src, mouseType: .mouseMoved,
                        mouseCursorPosition: pt, mouseButton: .left)
        if let e { stampForTarget(e, at: pt, clickState: 0, button: 0, phase: 2) }
        post(e)
    }
    ok("\"x\":\(x),\"y\":\(y)")
}

if cmd == "pos" {
    let p = CGEvent(source: nil)?.location ?? .zero
    ok("\"x\":\(p.x),\"y\":\(p.y)")
}

// MARK: - click / down / up

if cmd == "click" || cmd == "down" || cmd == "up" {
    requirePostAccess()
    let x = dbl(1, "x"), y = dbl(2, "y")
    let (btn, downT, upT) = mouseButton(str(3))
    let btnNum = buttonNumber(str(3))
    let pt = CGPoint(x: x, y: y)
    warp(pt)

    func mk(_ t: CGEventType, click: Int64) -> CGEvent? {
        let e = CGEvent(mouseEventSource: src, mouseType: t, mouseCursorPosition: pt, mouseButton: btn)
        if click > 0 { e?.setIntegerValueField(.mouseEventClickState, value: click) }
        if let e { stampForTarget(e, at: pt, clickState: max(1, click), button: btnNum, phase: 3) }
        return e
    }

    if cmd == "down" { primeTarget(pt); post(mk(downT, click: 1)); ok() }
    if cmd == "up"   { post(mk(upT,   click: 1)); ok() }

    let count = min(10, max(1, Int64(str(4).flatMap { Int($0) } ?? 1)))
    primeTarget(pt)
    for c in 1...count {
        post(mk(downT, click: c))
        // AppKit 的按钮靠 mouseDown 后的跟踪循环判定，down 与 up 贴太紧会被整个漏掉
        if targetPid != nil { usleep(28_000) }
        post(mk(upT,   click: c))
        // 双击的两对之间要留够间隔，否则会被合并成一次
        if c < count { usleep(80_000) }
    }
    ok("\"button\":\"\((str(3) ?? "left"))\",\"count\":\(count),\"routed\":\(targetPid != nil && canRouteToWindow)")
}


if cmd == "drag" || cmd == "moveto-drag" {
    requirePostAccess()
    let x1 = dbl(1, "x1"), y1 = dbl(2, "y1"), x2 = dbl(3, "x2"), y2 = dbl(4, "y2")
    let (btn, downT, upT) = mouseButton(str(5))
    let steps = max(1, Int(str(6).flatMap { Int($0) } ?? 20))
    let dragT: CGEventType = btn == .left ? .leftMouseDragged
        : (btn == .right ? .rightMouseDragged : .otherMouseDragged)
    let btnNum = buttonNumber(str(5))

    let start = CGPoint(x: x1, y: y1)
    warp(start)
    primeTarget(start)
    let down = CGEvent(mouseEventSource: src, mouseType: downT,
                       mouseCursorPosition: start, mouseButton: btn)
    down?.setIntegerValueField(.mouseEventClickState, value: 1)
    if let down { stampForTarget(down, at: start, clickState: 1, button: btnNum, phase: 3) }
    post(down)
    usleep(30_000)
    for s in 1...steps {
        let t = Double(s) / Double(steps)
        let pt = CGPoint(x: x1 + (x2 - x1) * t, y: y1 + (y2 - y1) * t)
        let e = CGEvent(mouseEventSource: src, mouseType: dragT,
                        mouseCursorPosition: pt, mouseButton: btn)
        e?.setIntegerValueField(.mouseEventClickState, value: 1)
        if let e { stampForTarget(e, at: pt, clickState: 1, button: btnNum, phase: 3) }
        post(e)
        usleep(12_000)
    }
    // 松手前留一帧：Chromium 要一个 run-loop 周期才会把最后一段拖拽处理完
    usleep(50_000)
    let end = CGPoint(x: x2, y: y2)
    let up = CGEvent(mouseEventSource: src, mouseType: upT,
                     mouseCursorPosition: end, mouseButton: btn)
    up?.setIntegerValueField(.mouseEventClickState, value: 1)
    if let up { stampForTarget(up, at: end, clickState: 1, button: btnNum, phase: 3) }
    post(up)
    ok("\"routed\":\(targetPid != nil && canRouteToWindow)")
}


if cmd == "scroll" {
    requirePostAccess()
    let x = dbl(1, "x"), y = dbl(2, "y")
    func clampWheel(_ v: Double) -> Int32 {
        if v.isNaN { return 0 }
        return Int32(max(-10000, min(10000, v.rounded())))
    }
    let dx = clampWheel(dbl(3, "dx")), dy = clampWheel(dbl(4, "dy"))
    let pt = CGPoint(x: x, y: y)
    warp(pt)
    // 滚动落在光标下的那个视图上：不先把命中态移过去，滚的就是目标窗口里的另一块区域
    primeTarget(pt)
    // 一次滚太多会被合并成一跳；拆成每次 ≤3 行、间隔 30ms，跟真实滚轮的节奏一致
    let steps = max(1, min(10, Int(max(abs(dx), abs(dy))) / 3 + 1))
    for i in 0..<steps {
        let last = (i == steps - 1)
        let part: (Int32) -> Int32 = { total in
            let per = total / Int32(steps)
            return last ? total - per * Int32(steps - 1) : per
        }
        let e = CGEvent(scrollWheelEvent2Source: src, units: .line, wheelCount: 2,
                        wheel1: part(dy), wheel2: part(dx), wheel3: 0)
        // postToPid 的滚轮事件不带位置就没法命中窗口，补上事件坐标
        e?.location = pt
        if let e { stampForTarget(e, at: pt, clickState: 0, button: 0, phase: 2) }
        post(e)
        if !last { usleep(30_000) }
    }
    ok("\"dx\":\(dx),\"dy\":\(dy),\"steps\":\(steps),\"routed\":\(targetPid != nil && canRouteToWindow)")
}


if cmd == "type" {
    requirePostAccess()
    signal(SIGTERM, { _ in reportTypedAndExit(143) })
    signal(SIGINT,  { _ in reportTypedAndExit(130) })
    var text: String
    if let a = str(1), a != "-" {
        text = a
    } else {
        let data = FileHandle.standardInput.readDataToEndOfFile()
        guard let s = String(data: data, encoding: .utf8) else { fail(3, "stdin is not valid UTF-8") }
        text = s
    }
    // --space <id>：打字中途用户切了桌面就立刻停手（长文本能打几分钟，键击会落进用户正用的窗口）。
    // API 拿不到时放行（fail-open），从 index 2 起找，避免撞上 argv 文本本身。
    var spaceGuard: (api: SpacesApi, expect: UInt64)? = nil
    if let i = args.dropFirst(2).firstIndex(of: "--space"), i + 1 < args.count,
       let want = UInt64(args[i + 1]), let api = loadSpacesApi() {
        spaceGuard = (api, want)
    }
    let SPACE_CHECK_EVERY = 40
    for scalar in text.unicodeScalars {
        // 父进程被 SIGKILL 后本进程会被过继给 launchd(pid 1)——没人能再叫停打字，必须自己停
        if getppid() == 1 { reportTypedAndExit(143) }
        if typedScalars % SPACE_CHECK_EVERY == 0, let g = spaceGuard, g.api.activeSpace() != g.expect {
            writeStderrRaw("{\"ok\":false,\"error\":\"space-changed\",\"typed\":\(typedScalars)}\n")
            _exit(7)
        }
        var utf16 = Array(String(scalar).utf16)
        let kd = CGEvent(keyboardEventSource: src, virtualKey: 0, keyDown: true)
        let ku = CGEvent(keyboardEventSource: src, virtualKey: 0, keyDown: false)
        kd?.keyboardSetUnicodeString(stringLength: utf16.count, unicodeString: &utf16)
        ku?.keyboardSetUnicodeString(stringLength: utf16.count, unicodeString: &utf16)
        post(kd)
        post(ku)
        typedScalars += 1
        if typedScalars % PROGRESS_EVERY == 0 {
            writeStderrRaw("{\"ok\":false,\"progress\":true,\"typed\":\(typedScalars)}\n")
        }
        usleep(1_500)
    }
    ok("\"len\":\(text.count),\"typed\":\(typedScalars)")
}


if cmd == "key" {
    requirePostAccess()
    guard let combo = str(1) else { fail(3, "missing combo") }
    let parts = combo.lowercased().split(separator: "+").map { String($0) }
    guard let keyName = parts.last else { fail(3, "empty combo") }

    var flags: CGEventFlags = []
    for m in parts.dropLast() {
        switch m {
        case "cmd", "command", "meta", "super": flags.insert(.maskCommand)
        case "shift":                            flags.insert(.maskShift)
        case "alt", "option", "opt":             flags.insert(.maskAlternate)
        case "ctrl", "control":                  flags.insert(.maskControl)
        case "fn", "function":                   flags.insert(.maskSecondaryFn)
        default: fail(3, "unknown modifier: \(m)")
        }
    }

    let map: [String: CGKeyCode] = [
        "a":0,"s":1,"d":2,"f":3,"h":4,"g":5,"z":6,"x":7,"c":8,"v":9,"b":11,"q":12,
        "w":13,"e":14,"r":15,"y":16,"t":17,"1":18,"2":19,"3":20,"4":21,"6":22,"5":23,
        "=":24,"9":25,"7":26,"-":27,"8":28,"0":29,"]":30,"o":31,"u":32,"[":33,"i":34,
        "p":35,"l":37,"j":38,"'":39,"k":40,";":41,"\\":42,",":43,"/":44,"n":45,"m":46,
        ".":47,"`":50,
        "return":36,"enter":36,"tab":48,"space":49,"delete":51,"backspace":51,
        "escape":53,"esc":53,"forwarddelete":117,
        "left":123,"right":124,"down":125,"up":126,
        "home":115,"end":119,"pageup":116,"pagedown":121,
        "f1":122,"f2":120,"f3":99,"f4":118,"f5":96,"f6":97,"f7":98,"f8":100,
        "f9":101,"f10":109,"f11":103,"f12":111,
    ]
    guard let code = map[keyName] else { fail(3, "unknown key: \(keyName)") }
    let kd = CGEvent(keyboardEventSource: src, virtualKey: code, keyDown: true)
    let ku = CGEvent(keyboardEventSource: src, virtualKey: code, keyDown: false)
    kd?.flags = flags
    ku?.flags = flags
    post(kd)
    post(ku)
    ok("\"key\":\"\(combo)\"")
}

// MARK: - Accessibility 动作（ghost 模式的「鼠标」：坐标→元素→动作，不碰系统光标）
// 实测结论（2026-08-21，本机 Darwin 27）：CGEventPostToPid 的鼠标事件到得了进程，
// 但 NSEvent.windowNumber=0 → AppKit/Chromium 都无法路由到窗口，点击必然丢失；
// 键盘事件则能正常进入后台 App 的焦点元素。所以点击走 AX，打字走键盘注入。

func axAttr(_ el: AXUIElement, _ key: String) -> CFTypeRef? {
    var v: CFTypeRef?
    return AXUIElementCopyAttributeValue(el, key as CFString, &v) == .success ? v : nil
}
func axString(_ el: AXUIElement, _ key: String) -> String { (axAttr(el, key) as? String) ?? "" }
func axActions(_ el: AXUIElement) -> [String] {
    var arr: CFArray?
    return AXUIElementCopyActionNames(el, &arr) == .success ? ((arr as? [String]) ?? []) : []
}
func axFrame(_ el: AXUIElement) -> CGRect {
    var pos = CGPoint.zero, size = CGSize.zero
    if let p = axAttr(el, kAXPositionAttribute as String) { AXValueGetValue(p as! AXValue, .cgPoint, &pos) }
    if let s = axAttr(el, kAXSizeAttribute as String) { AXValueGetValue(s as! AXValue, .cgSize, &size) }
    return CGRect(origin: pos, size: size)
}
func axElement(_ v: CFTypeRef?) -> AXUIElement? {
    guard let v, CFGetTypeID(v) == AXUIElementGetTypeID() else { return nil }
    return (v as! AXUIElement)
}

// _AXUIElementGetWindow：私有但一直在的符号，把 AXWindow 换成 CGWindowID。
// 没它就只能拿 frame 认窗口（同 App 的同尺寸窗口会认错），所以优先用它。
typealias GBDAXGetWindowFn = @convention(c) (AXUIElement, UnsafeMutablePointer<CGWindowID>) -> AXError
let axGetWindowFn: GBDAXGetWindowFn? = {
    guard let p = dlsym(UnsafeMutableRawPointer(bitPattern: -2), "_AXUIElementGetWindow") else { return nil }
    return unsafeBitCast(p, to: GBDAXGetWindowFn.self)
}()

func axWindowID(_ el: AXUIElement) -> CGWindowID? {
    guard let fn = axGetWindowFn else { return nil }
    var wid: CGWindowID = 0
    return fn(el, &wid) == .success && wid != 0 ? wid : nil
}

/// 顺着 kAXParent 找到元素所属的顶层 AXWindow。菜单栏之类不在任何窗口里的元素返回 nil。
func topLevelWindow(of el: AXUIElement) -> AXUIElement? {
    let windowRole = kAXWindowRole as String
    if let w = axElement(axAttr(el, kAXWindowAttribute as String)) { return w }
    if let t = axElement(axAttr(el, kAXTopLevelUIElementAttribute as String)),
       axString(t, kAXRoleAttribute as String) == windowRole { return t }
    var cur = el
    for _ in 0..<32 {
        if axString(cur, kAXRoleAttribute as String) == windowRole { return cur }
        guard let p = axElement(axAttr(cur, kAXParentAttribute as String)) else { return nil }
        cur = p
    }
    return nil
}

/// 命中元素是不是真的属于目标窗口。method 会写进返回 JSON，方便调用方知道用的是哪种判据。
func belongsToTarget(_ el: AXUIElement, wid: CGWindowID?, rect: CGRect?) -> (ok: Bool, method: String) {
    let top = topLevelWindow(of: el)
    if let wid {
        // 先看元素自己落在哪个 CGWindow：sheet/popover 自成一个窗口号（截图和 winpick 看到的
        // 也是那个号），但 AX 上它挂在父窗口下。两层认一层就算目标——挂在目标窗上的模态 sheet
        // 本来就是目标的一部分，不该被当成「点歪了」。
        if let own = axWindowID(el), own == wid { return (true, "wid") }
        if let top, let got = axWindowID(top) { return (got == wid, "wid") }
    }
    guard let rect, rect.width > 1, rect.height > 1 else {
        return top == nil ? (false, "no-window") : (true, "none")
    }
    func area(_ r: CGRect) -> Double { r.isNull ? 0 : Double(r.width * r.height) }
    // 退路（私有符号哪天没了，或 --winnum 没给）：按 frame 认。
    // 实测 AXWindow frame 与 CGWindowBounds 完全一致，用 IoU 而不是逐边比较，
    // 窗口在两次读数之间小幅移动也不会误判。
    if let top {
        let f = axFrame(top)
        if f.width > 1 && f.height > 1 {
            let ia = area(f.intersection(rect))
            let ua = area(f) + area(rect) - ia
            // IoU 不过就是另一扇窗，到此为止。同 App 的兄弟窗口常常整个套在目标矩形里
            //（实测微信 10401 完全落在 117 内），再补一条「元素自己在矩形里就算数」的退路，
            // 等于在这条路径上根本没做窗口身份校验。
            return (ua > 0 && ia / ua >= 0.7, "frame")
        }
    }
    // 顶层窗口压根认不出来（AX 上没有 window 祖先，或者它不报 frame）：只剩元素自己的位置可依
    let ef = axFrame(el)
    let cover = area(ef) > 0 ? area(ef.intersection(rect)) / area(ef) : 0
    if cover >= 0.9 { return (true, "frame") }
    return (false, top == nil ? "no-window" : "frame")
}

/// stale-target：点不在目标窗口里。error 字段固定，方便 server.mjs 区分（不要改成人话）。
func failStale(_ detail: String) -> Never {
    FileHandle.standardError.write(
        ("{\"ok\":false,\"error\":\"stale-target\",\"message\":" + jsonStr(detail) + "}\n").data(using: .utf8)!)
    exit(7)
}

/// 目标进程没了的话，后面所有 AX 调用都会超时（-25204），错误里会写成「App 正忙」误导调用方。
func requireAlive(_ pid: pid_t) {
    if kill(pid, 0) != 0 && errno == ESRCH { fail(5, "目标进程已退出（pid \(pid) 不存在）") }
}

/// 每个 ax 子命令动手前都得先做这三件事。
/// Chromium/Electron 只在有 AX 客户端索要时才建树，而且认的是**发起请求的进程**——
/// 上一个进程退出树就没了，所以每次进程启动都要自己设一遍，不能指望别人设过。
func axPrepare(_ appEl: AXUIElement) {
    AXUIElementSetMessagingTimeout(appEl, 2.0)
    AXUIElementSetAttributeValue(appEl, "AXManualAccessibility" as CFString, kCFBooleanTrue)
    // 建树是异步的：轮询到有窗口为止，最多 1s（按墙上时钟算，不是按轮数）。
    // 卡死的目标每次取 kAXWindows 都会耗满超时，按轮数算 20 轮 × 2s ≈ 40s，
    // 超过 server 的 30s 上限，还会把它串行的输入队列一起堵住；轮询期间把超时压到 0.2s。
    AXUIElementSetMessagingTimeout(appEl, 0.2)
    let deadline = Date().addingTimeInterval(1.0)
    repeat {
        if let wins = axAttr(appEl, kAXWindowsAttribute as String) as? [AXUIElement], !wins.isEmpty { break }
        usleep(50_000)
    } while Date() < deadline
    // 超时也照常往下走——有些 App 本来就没有 AXWindow（菜单栏应用），不该在这里直接判死。
    AXUIElementSetMessagingTimeout(appEl, 2.0)
}

/// 命中点常常是 AXScrollArea/AXGroup 这类容器：聚焦容器不会把键盘焦点交给里面的输入框，
/// 打字就会掉进虚空。往下找一个真正能接收键盘的后代——但只认**盖住命中点**的那些，且取最深的一个。
/// 返回一个不含该点的元素等于把这次点击悄悄挪到了别的控件上：实测在 Chrome 上会捞到页首
/// 1×1 的隐藏跳转链接（离目标 1000px），调用方还会照着它劝模型敲回车去激活。
let TEXTISH_ROLES = ["AXTextField", "AXTextArea", "AXComboBox", "AXSearchField"]
// 有些 App 大片元素不报 position/size，几何未知的节点必须继续钻，深度上限挡不住这种发散
var focusScanBudget = 400
func focusableDescendant(_ el: AXUIElement, containing pt: CGPoint, _ depth: Int = 0) -> AXUIElement? {
    if depth > 5 || focusScanBudget <= 0 { return nil }
    focusScanBudget -= 1
    let f = axFrame(el)
    // 不报 position/size 的容器：几何未知就继续往下钻，但它自己不能当答案
    let placed = f.width > 0 && f.height > 0
    if placed && !f.contains(pt) { return nil }
    // 先钻子节点：点上真正的控件是最深（最小）的那个，聚焦外层容器等于没聚焦
    if let kids = axAttr(el, kAXChildrenAttribute as String) as? [AXUIElement] {
        for k in kids.prefix(24) {
            if let inner = focusableDescendant(k, containing: pt, depth + 1) { return inner }
        }
    }
    guard placed else { return nil }
    if TEXTISH_ROLES.contains(axString(el, kAXRoleAttribute as String)) { return el }
    var settable = DarwinBoolean(false)
    if AXUIElementIsAttributeSettable(el, kAXFocusedAttribute as CFString, &settable) == .success,
       settable.boolValue, depth > 0 {
        return el
    }
    return nil
}

func axDescribeJSON(_ el: AXUIElement) -> String {
    let f = axFrame(el)
    let valueStr = (axAttr(el, kAXValueAttribute as String) as? String) ?? ""
    return "\"role\":\(jsonStr(axString(el, kAXRoleAttribute as String))),"
        + "\"title\":\(jsonStr(axString(el, kAXTitleAttribute as String))),"
        + "\"desc\":\(jsonStr(axString(el, kAXDescriptionAttribute as String))),"
        + "\"value\":\(jsonStr(valueStr)),"
        + "\"actions\":[\(axActions(el).map { jsonStr($0) }.joined(separator: ","))],"
        + "\"frame\":{\"x\":\(Int(f.minX)),\"y\":\(Int(f.minY)),\"w\":\(Int(f.width)),\"h\":\(Int(f.height))}"
}

// MARK: - AX 请求 / 结果（CLI 与常驻服务共用同一份实现）
//
// 这三个 AX 命令原本各自算完直接 exit()，没法在常驻循环里复用。
// 现在统一成「吃一个 AXReq、吐一个 CmdOut」，CLI 那头照旧打印+退出，
// serve 那头把同一个 CmdOut 编成一行 JSON 回给调用方。

struct CmdOut {
    var ok: Bool
    var code: Int32 = 0
    var body: String = ""       // ok 时拼进 JSON 的字段
    var error: String = ""      // 机器码（stale-target 之类）或人话
    var message: String? = nil  // 机器码对应的人话
}
func outOK(_ body: String = "") -> CmdOut { CmdOut(ok: true, body: body) }
func outFail(_ code: Int32, _ msg: String) -> CmdOut { CmdOut(ok: false, code: code, error: msg) }
/// stale-target：坐标/路径指向的东西已经不是当初那个了。error 字段固定给调用方判断用。
func outStale(_ detail: String) -> CmdOut {
    CmdOut(ok: false, code: 7, error: "stale-target", message: detail)
}

struct AXReq {
    var sub = ""
    var x = 0.0, y = 0.0
    var pid: pid_t = 0
    var wid: CGWindowID? = nil
    var winX: Double? = nil, winY: Double? = nil, winW: Double? = nil, winH: Double? = nil
    var path: String? = nil
    var expectRole: String? = nil
    var expectTitle: String? = nil
    var raise = false
    var allowSelfDestruct = false
    var maxNodes = 2000
    var text: String? = nil     // setval 的内容

    var winRect: CGRect? {
        guard let wx = winX, let wy = winY else { return nil }
        return CGRect(x: wx, y: wy, width: winW ?? 1, height: winH ?? 1)
    }
}

/// 常驻模式：进程活着的时候把 app 元素和「准备过了」的状态留住。
/// Chromium/Electron 的 a11y 树认**发起请求的进程**——每个动作 spawn 一次进程，
/// 就要重新建一次树（还得等它建好，最坏 1s）。常驻之后建一次就够了。
var residentMode = false
var appElCache = [pid_t: AXUIElement]()
var preparedAt = [pid_t: Date]()

func preparedApp(_ pid: pid_t) -> AXUIElement {
    let el: AXUIElement
    if let c = appElCache[pid] { el = c } else {
        el = AXUIElementCreateApplication(pid)
        appElCache[pid] = el
    }
    if !residentMode { axPrepare(el); return el }
    let last = preparedAt[pid]
    if last == nil {
        axPrepare(el)
        preparedAt[pid] = Date()
        return el
    }
    // 树可能塌了（App 重启、窗口挪去别的桌面）。窗口列表空了就重建一次，
    // 但别每次请求都重来——axPrepare 最坏要等 1s，空窗口列表是常态（用户在全屏 App 里）。
    let empty = (axAttr(el, kAXWindowsAttribute as String) as? [AXUIElement])?.isEmpty != false
    if empty, Date().timeIntervalSince(last!) > 2.0 {
        axPrepare(el)
        preparedAt[pid] = Date()
    }
    return el
}
func forgetApp(_ pid: pid_t) {
    appElCache[pid] = nil
    preparedAt[pid] = nil
}

/// 目标进程没了：后面所有 AX 调用都会超时（-25204），错误里会写成「App 正忙」误导调用方。
func aliveCheck(_ pid: pid_t) -> CmdOut? {
    if kill(pid, 0) != 0 && errno == ESRCH {
        forgetApp(pid)
        return outFail(5, "目标进程已退出（pid \(pid) 不存在）")
    }
    return nil
}

// axcheck --pid <n> [--winnum <id>]：判断该 App/窗口是否真的暴露可用的 AX 窗口树。
// 用来在 ghost 初始化时把 iPhone Mirroring 这类「有进程但窗口内容不走 AX」的目标筛掉，
// 而不是靠命中窗口中心一个点（那点可能落在菜单栏/空白上，会误判）。
func runAxCheck(_ req: AXReq) -> CmdOut {
    guard AXIsProcessTrusted() else { return outFail(2, "「辅助功能」未授权") }
    guard let wx = req.winX, let wy = req.winY, let ww = req.winW, let wh = req.winH else {
        return outFail(3, "axcheck 需要 --wx --wy --ww --wh")
    }
    if let dead = aliveCheck(req.pid) { return dead }
    let appEl = preparedApp(req.pid)
    // 判据：窗口内多点取样，命中的元素必须是**这个窗口里的真后代**。同 App 的另一个窗口不算；
    // 裸的 AXWindow/AXApplication/菜单栏也不算——那是「这个点上我没有控件」的另一种说法
    //（实测连越界坐标都照样返回窗口本身）。放行它们，「有进程但内容不走 AX」的窗口就会混过检查，
    // ghost 锁上一个点不动、也控制不了的目标（用户看到的「无头」就是这么来的）。
    let winRect = CGRect(x: wx, y: wy, width: ww, height: wh)
    let samples: [(Double, Double)] = [(0.5, 0.5), (0.3, 0.35), (0.7, 0.65),
                                       (0.5, 0.22), (0.3, 0.7), (0.7, 0.3)]
    var inside = 0
    var method = axGetWindowFn == nil ? "frame" : "wid"
    let NON_CONTENT_ROLES = [kAXWindowRole as String, kAXApplicationRole as String,
                             "AXMenuBar", "AXMenuBarItem"]
    for (fx, fy) in samples {
        let px = wx + ww * fx, py = wy + wh * fy
        var el: AXUIElement?
        guard AXUIElementCopyElementAtPosition(appEl, Float(px), Float(py), &el) == .success, let e = el else { continue }
        if NON_CONTENT_ROLES.contains(axString(e, kAXRoleAttribute as String)) { continue }
        let m = belongsToTarget(e, wid: req.wid, rect: winRect)
        if m.method != "no-window" { method = m.method }
        if m.ok { inside += 1 }
    }
    if inside == 0 {
        return outFail(6, "该窗口内容不走辅助功能（取样点只命中窗口本身/菜单栏，或落在别的窗口里），无法用独立指针控制")
    }
    return outOK("\"inside\":\(inside),\"sampled\":\(samples.count),\"identity\":\"\(method)\"")
}

// MARK: - 元素枚举（按编号操作，绕开「坐标过期」）
//
// 思路来自 browser-use/macOS-use（MIT）：不给模型坐标，给它一份编号过的控件清单，
// 让它说「按 3 号」。可交互与否**看元素支持哪些 AXAction**，不靠角色白名单去猜。
// 几何过滤（丢掉零尺寸/跑到窗口外的）来自 simular-ai/Agent-S（Apache-2.0）。
// 遍历预算（节点数/深度/每层子节点/墙上时钟）来自 mediar-ai/MacosUseSDK（MIT）。
//
// 引用怎么保活是本地的问题：那两个项目都是常驻进程，能把 AXUIElement 攥在内存里；
// 我们每个动作 spawn 一次，进程一死引用就没了。所以编号背后存的是**从窗口根节点数下来的
// 子节点索引路径**（"2.0.5"），点的时候照着路径再走一遍，并核对角色/标题对不对得上——
// 界面变了就明确报错让模型重读，而不是照着旧位置点下去。
let INTERACTIVE_ACTIONS: Set<String> = [
    "AXPress", "AXShowMenu", "AXIncrement", "AXDecrement",
    "AXConfirm", "AXCancel", "AXPick", "AXOpen",
]
// 纯容器/装饰：本身不可操作，但要继续往下钻
let SKIP_ROLES: Set<String> = [
    "AXGroup", "AXLayoutArea", "AXLayoutItem", "AXUnknown", "AXSplitGroup",
    "AXScrollArea", "AXSplitter", "AXHelpTag", "AXGrowArea", "AXOutline",
]

struct FoundElement {
    let path: String
    let role: String
    let subrole: String
    let title: String
    let value: String
    let frame: CGRect
    let actions: [String]
    let enabled: Bool
}

/// 一次取齐要用的属性：逐个 AXUIElementCopyAttributeValue 在大树上明显更慢
/// （本机实测 0.55ms/节点 → 0.24ms/节点）。
let ELEMENT_KEYS = [kAXRoleAttribute, kAXTitleAttribute, kAXDescriptionAttribute,
                    kAXValueAttribute, kAXEnabledAttribute, kAXPositionAttribute,
                    kAXSizeAttribute, kAXSubroleAttribute, kAXRoleDescriptionAttribute] as CFArray

struct ReadResult {
    let role: String, subrole: String, title: String, value: String
    let enabled: Bool, frame: CGRect
}

func readElement(_ el: AXUIElement) -> ReadResult {
    var out: CFArray?
    guard AXUIElementCopyMultipleAttributeValues(
            el, ELEMENT_KEYS, AXCopyMultipleAttributeOptions(rawValue: 0), &out) == .success,
          let vals = out as? [AnyObject], vals.count >= 9 else {
        return ReadResult(role: axString(el, kAXRoleAttribute as String), subrole: "",
                          title: axString(el, kAXTitleAttribute as String), value: "",
                          enabled: true, frame: axFrame(el))
    }
    // 取不到的位置会是 NSNull 或内嵌一个 AXError，取值前都得判一下
    func str(_ i: Int) -> String { (vals[i] as? String) ?? "" }
    var pos = CGPoint.zero, size = CGSize.zero
    if CFGetTypeID(vals[5]) == AXValueGetTypeID() { AXValueGetValue(vals[5] as! AXValue, .cgPoint, &pos) }
    if CFGetTypeID(vals[6]) == AXValueGetTypeID() { AXValueGetValue(vals[6] as! AXValue, .cgSize, &size) }
    // 名字按「最像人话」的顺序退：标题 → 描述（工具栏按钮常常只有这个）→ 值 →
    // 角色描述（"关闭按钮" 这种，系统给的本地化名，总比空字符串强）
    var title = str(1)
    if title.isEmpty { title = str(2) }
    if title.isEmpty { title = String(str(3).prefix(40)) }
    if title.isEmpty { title = str(8) }
    let enabled = (vals[4] as? NSNumber)?.boolValue ?? true
    return ReadResult(role: str(0), subrole: str(7), title: title, value: str(3),
                      enabled: enabled, frame: CGRect(origin: pos, size: size))
}

/// 会把 ghost 自己的视野弄没的窗口控件：关闭 / 最小化 / 全屏。
/// Grok 全靠这一个窗口看和操作，按下去就等于自断视野，还得让用户去把窗口找回来。
let SELF_DESTRUCT_SUBROLES: Set<String> = [
    "AXCloseButton", "AXMinimizeButton", "AXFullScreenButton", "AXZoomButton",
]

/// 顺着索引路径把元素找回来。任一段越界就返回 nil（界面结构变了）。
func resolvePath(_ root: AXUIElement, _ path: String) -> AXUIElement? {
    var cur = root
    for part in path.split(separator: ".") {
        guard let idx = Int(part),
              let kids = axAttr(cur, kAXChildrenAttribute as String) as? [AXUIElement],
              idx >= 0, idx < kids.count else { return nil }
        cur = kids[idx]
    }
    return cur
}

// elements --pid <n> [--winnum <id>] [--max <n>]：列出目标窗口里可操作的控件
func runElements(_ req: AXReq) -> CmdOut {
    guard AXIsProcessTrusted() else { return outFail(2, "「辅助功能(Accessibility)」未授权") }
    if let dead = aliveCheck(req.pid) { return dead }
    let appEl = preparedApp(req.pid)
    guard let wins = axAttr(appEl, kAXWindowsAttribute as String) as? [AXUIElement], !wins.isEmpty else {
        // 窗口不在当前桌面时 kAXWindows 会是空的，这跟「这个 App 没有辅助功能」不是一回事
        return outFail(6, "拿不到该 App 的窗口列表（窗口可能不在当前桌面，或该 App 不暴露辅助功能树）")
    }
    let root = req.wid.flatMap { wid in wins.first { axWindowID($0) == wid } } ?? wins[0]
    let winRect = axFrame(root)
    let maxNodes = req.maxNodes
    let deadline = Date().addingTimeInterval(4.0)

    var found = [FoundElement]()
    var scanned = 0
    var truncated = false
    func walk(_ el: AXUIElement, _ path: String, _ depth: Int) {
        if scanned >= maxNodes || depth > 60 || Date() > deadline { truncated = true; return }
        scanned += 1
        let e = readElement(el)
        let acts = axActions(el)
        let interactive = !acts.filter { INTERACTIVE_ACTIONS.contains($0) }.isEmpty
            || (acts.contains("AXSetValue") && TEXTISH_ROLES.contains(e.role))
        // 几何上站得住：有面积，且确实落在窗口里（离屏/收起来的菜单会跑到窗口外）
        let placed = e.frame.width > 0 && e.frame.height > 0
        let inside = placed && winRect.intersects(e.frame)
        if interactive && inside && !path.isEmpty {
            found.append(FoundElement(path: path, role: e.role, subrole: e.subrole, title: e.title,
                                      value: e.value, frame: e.frame, actions: acts, enabled: e.enabled))
        }
        // 容器自己不算答案，但里面的东西要接着找；已经跑到窗口外的子树整片跳过
        if placed && !inside && !SKIP_ROLES.contains(e.role) { return }
        guard let kids = axAttr(el, kAXChildrenAttribute as String) as? [AXUIElement] else { return }
        for (i, k) in kids.prefix(250).enumerated() {
            if scanned >= maxNodes || Date() > deadline { truncated = true; return }
            walk(k, path.isEmpty ? "\(i)" : "\(path).\(i)", depth + 1)
        }
    }
    walk(root, "", 0)
    // 从上到下、从左到右：跟人读界面的顺序一致，编号才稳定好认
    found.sort { a, b in
        let ay = Int(a.frame.midY / 8), by = Int(b.frame.midY / 8)   // 同一行的按钮不该因为差几个像素而乱序
        return ay == by ? a.frame.minX < b.frame.minX : ay < by
    }
    let items = found.enumerated().map { (i, f) -> String in
        // 报的点必须落在窗口里：长文档的 AXTextArea 高好几千，中心点在窗口外几屏之远，
        // 照它去点会点到别的地方。取「元素 ∩ 窗口」的中心才是真正点得到的位置。
        let visible = f.frame.intersection(winRect)
        let pt = visible.isNull ? CGPoint(x: f.frame.midX, y: f.frame.midY)
                                : CGPoint(x: visible.midX, y: visible.midY)
        let danger = SELF_DESTRUCT_SUBROLES.contains(f.subrole) ? ",\"selfDestruct\":true" : ""
        return """
        {"i":\(i),"path":\(jsonStr(f.path)),"role":\(jsonStr(f.role)),\
        "subrole":\(jsonStr(f.subrole)),"title":\(jsonStr(f.title)),\
        "value":\(jsonStr(String(f.value.prefix(120)))),"enabled":\(f.enabled),\
        "x":\(Int(pt.x)),"y":\(Int(pt.y)),\
        "w":\(Int(f.frame.width)),"h":\(Int(f.frame.height)),\
        "actions":[\(f.actions.map { jsonStr($0) }.joined(separator: ","))]\(danger)}
        """
    }
    return outOK("\"scanned\":\(scanned),\"truncated\":\(truncated),"
        + "\"win\":{\"x\":\(Int(winRect.minX)),\"y\":\(Int(winRect.minY)),"
        + "\"w\":\(Int(winRect.width)),\"h\":\(Int(winRect.height))},"
        + "\"elements\":[\(items.joined(separator: ","))]")
}

// ax <hit|press|focus|setval|raise> <x> <y> --pid <n> [--winnum <id>] [--wx --wy --ww --wh] [--raise]
func runAx(_ req: AXReq) -> CmdOut {
    guard AXIsProcessTrusted() else {
        return outFail(2, "「辅助功能(Accessibility)」未授权，AX 控制不可用")
    }
    let sub = req.sub
    if sub.isEmpty { return outFail(3, "missing ax subcommand") }
    let x = req.x, y = req.y
    if let dead = aliveCheck(req.pid) { return dead }
    let appEl = preparedApp(req.pid)

    let winW = req.winW
    let winH = req.winH
    let winRect: CGRect? = req.winRect
    let targetWid = req.wid

    // raise 必须走在命中测试前面：有的 App 压根不实现 AXUIElementCopyElementAtPosition
    //（微信 -25208），但窗口照样抬得起来。放在门禁后面会让 target_window 误报「这个 App 控制不了」。
    if sub == "raise" {
        // 把目标窗口抬到本 Space 的最前（x,y 传窗口原点做匹配）。
        // 只用 AXRaise，不调 NSRunningApplication.activate —— 后者会把用户硬拽到别的 Space。
        guard let wins = axAttr(appEl, kAXWindowsAttribute as String) as? [AXUIElement], !wins.isEmpty else {
            return outFail(5, "拿不到该 App 的窗口列表")
        }
        var target: AXUIElement? = targetWid.flatMap { wid in wins.first { axWindowID($0) == wid } }
        if target == nil {
            // 认不出 CGWindowID 就按重叠面积挑：原点精确匹配太脆（阴影/标题栏/多窗口都会差几个点）
            let want = CGRect(x: x, y: y, width: winW ?? 1, height: winH ?? 1)
            var bestScore = 0.0
            for w in wins {
                let f = axFrame(w)
                let inter = f.intersection(want)
                let score = inter.isNull ? 0 : inter.width * inter.height
                // 没给宽高时退回原点距离
                let fallback = (abs(f.minX - x) < 12 && abs(f.minY - y) < 12) ? 1.0 : 0.0
                let s = max(score, fallback)
                if s > bestScore { bestScore = s; target = w }
            }
        }
        guard let t = target else { return outFail(5, "没有匹配该位置的窗口") }
        if AXUIElementPerformAction(t, kAXRaiseAction as CFString) == .success {
            return outOK("\"did\":\"raise\"")
        }
        // 有些窗口（如 iPhone 投屏）不支持 AXRaise，退而设为该 App 的主窗口
        if AXUIElementSetAttributeValue(t, kAXMainAttribute as CFString, kCFBooleanTrue) == .success {
            return outOK("\"did\":\"main\"")
        }
        return outFail(6, "抬起窗口失败（AXRaise 与 AXMain 都不支持）")
    }

    // --path：按 elements 给的索引路径定位，全程不碰坐标——窗口移动/改大小都不影响。
    // 但界面本身变了（弹了个面板、列表刷新）路径就会指向别的东西，所以必须核对角色/标题：
    // 对不上就报 stale-target 让调用方重读清单，绝不照着按下去。
    if let path = req.path {
        guard let wins = axAttr(appEl, kAXWindowsAttribute as String) as? [AXUIElement], !wins.isEmpty else {
            return outFail(6, "拿不到该 App 的窗口列表（窗口可能不在当前桌面）")
        }
        let root = targetWid.flatMap { wid in wins.first { axWindowID($0) == wid } } ?? wins[0]
        guard let el = resolvePath(root, path) else {
            return outStale("控件路径 \(path) 已经失效（界面结构变了）：请重新读取控件清单再操作。")
        }
        let got = readElement(el)
        if let want = req.expectRole, !want.isEmpty, got.role != want {
            return outStale("控件路径 \(path) 现在指向的是 \(got.role)，不是当初的 \(want)：界面已经变了，请重新读取控件清单。")
        }
        if let want = req.expectTitle, !want.isEmpty, got.title != want {
            return outStale("控件路径 \(path) 现在的标题是 \(got.title)，不是当初的 \(want)："
                + "界面已经变了，请重新读取控件清单。")
        }
        let acts = axActions(el)
        switch sub {
        case "hit":
            return outOK("\"by\":\"path\"," + axDescribeJSON(el))
        case "press":
            if !got.enabled { return outFail(6, "该控件当前不可用（灰掉了）：\(got.title)") }
            // 关闭/最小化/全屏：ghost 全靠这个窗口看和操作，按下去自己就瞎了
            if SELF_DESTRUCT_SUBROLES.contains(got.subrole), !req.allowSelfDestruct {
                return outFail(6, "不执行：这是窗口的\(got.title.isEmpty ? got.subrole : got.title)按钮，"
                    + "按下去会让正在用来观察和操作的这个窗口消失。确实要关请先问用户。")
            }
            guard acts.contains(kAXPressAction as String) else {
                return outFail(6, "该控件没有 AXPress 动作（可用动作：\(acts.joined(separator: "/"))）")
            }
            let e = AXUIElementPerformAction(el, kAXPressAction as CFString)
            if e != .success { return outFail(6, "AXPress 失败 err=\(e.rawValue)") }
            return outOK("\"by\":\"path\",\"did\":\"press\"," + axDescribeJSON(el))
        case "focus":
            let e = AXUIElementSetAttributeValue(el, kAXFocusedAttribute as CFString, kCFBooleanTrue)
            if e != .success { return outFail(6, "AX 聚焦失败 err=\(e.rawValue)") }
            return outOK("\"by\":\"path\",\"did\":\"focus\"," + axDescribeJSON(el))
        case "setval":
            guard let text = req.text else { return outFail(3, "setval 需要文本内容") }
            let e = AXUIElementSetAttributeValue(el, kAXValueAttribute as CFString, text as CFTypeRef)
            if e != .success { return outFail(6, "AX 写值失败 err=\(e.rawValue)（该控件可能只读）") }
            return outOK("\"by\":\"path\",\"did\":\"setval\",\"len\":\(text.count)")
        default:
            return outFail(3, "--path 不支持子命令 \(sub)")
        }
    }

    // --raise：动作前先把目标窗抬上来。命中测试本身不需要（它不怕遮挡），
    // 但用户得看得见 Grok 在操作谁，键盘注入也才落在预期的窗口上。
    if req.raise, let want = winRect,
       let wins = axAttr(appEl, kAXWindowsAttribute as String) as? [AXUIElement] {
        var best: AXUIElement? = targetWid.flatMap { wid in wins.first { axWindowID($0) == wid } }
        if best == nil {
            var bestScore = 0.0
            for w in wins {
                let inter = axFrame(w).intersection(want)
                let s = inter.isNull ? 0 : inter.width * inter.height
                if s > bestScore { bestScore = s; best = w }
            }
        }
        if let t = best {
            if AXUIElementPerformAction(t, kAXRaiseAction as CFString) != .success {
                AXUIElementSetAttributeValue(t, kAXMainAttribute as CFString, kCFBooleanTrue)
            }
            usleep(200_000)
        }
    }

    let pt = CGPoint(x: x, y: y)
    let staleHint = "：窗口在上次截图之后可能移动过、改了大小，或者已经不在当前桌面。"
        + "请重新截图确认坐标再试。"

    var hit: AXUIElement?
    let herr = AXUIElementCopyElementAtPosition(appEl, Float(x), Float(y), &hit)
    guard herr == .success, let el = hit else {
        switch herr {
        case .cannotComplete:
            return outFail(5, "目标 App 响应超时（2s 内没回 AX 请求）：它可能正忙或卡住了，稍后重试")
        case .notImplemented:
            return outFail(5, "该 App 不支持按坐标命中元素（没实现 AXUIElementCopyElementAtPosition）")
        case .noValue:
            // 「这个位置什么都没有」和命中菜单栏是同一件事：点没落在目标窗口里。
            // 判成 5 的话调用方不会去重拍刷新坐标，还会被告知「这个 App 没有辅助功能树」——冤枉它。
            return outStale("该点不在目标窗口内（该位置没有任何元素）" + staleHint)
        default:
            return outFail(5, "该点没有可访问元素（AX err=\(herr.rawValue)）：目标 App 可能没暴露辅助功能树")
        }
    }
    // 命中的东西必须真的属于目标窗口。拿到 AXMenuBar 只说明一件事：这个点不在该 App 的任何
    // AX 窗口里——要么坐标过期（窗口在上次截图后移动/改了大小），要么 Chromium 把树拆了。
    var identity = ""
    let role = axString(el, kAXRoleAttribute as String)
    if ["press", "focus", "hit", "setval"].contains(sub) {
        if role == "AXMenuBar" || role == "AXMenuBarItem" {
            return outStale("该点不在目标窗口内（命中的是菜单栏）" + staleHint)
        }
        // 命中裸的 AXWindow/AXApplication，是 App 在说「这个点上没有我的控件」，
        // 跟菜单栏是同一类非答案。实测越界的坐标（x 落在窗口右边界外）也会回窗口本身，
        // 所以按几何分流：点在窗口外 = 坐标过期，交给调用方重拍；点在窗口里 = 这儿确实没东西。
        if role == kAXApplicationRole as String {
            return outStale("该点不在目标窗口内（命中的是 App 本身，不是任何窗口）" + staleHint)
        }
        if role == kAXWindowRole as String {
            if !axFrame(el).contains(pt) {
                return outStale("该点落在目标窗口之外（命中的是窗口本身）" + staleHint)
            }
            if sub != "hit" {
                return outFail(6, "该点上没有任何控件（命中的是窗口本身，不是窗口里的元素）：重新截图看清要点的东西在哪再试")
            }
        }
        if targetWid != nil {
            let m = belongsToTarget(el, wid: targetWid, rect: winRect)
            if !m.ok { return outStale("该点命中的不是目标窗口（判据 \(m.method)）" + staleHint) }
            identity = "\"identity\":\"\(m.method)\","
        } else if let want = winRect, !want.intersects(axFrame(el)) {
            return outStale("该点命中的元素落在目标窗口之外（\(role.isEmpty ? "无角色" : role)）" + staleHint)
        }
    }
    switch sub {
    case "hit":
        return outOK(identity + axDescribeJSON(el))
    case "press":
        // 只有真按下去才算 press。没有 AXPress 时可以退到聚焦，但必须如实报 did:"focus"——
        // 谎报成功会让模型以为按钮点过了，然后一直等一个永远不会来的界面变化。
        if axActions(el).contains(kAXPressAction as String) {
            let e = AXUIElementPerformAction(el, kAXPressAction as CFString)
            if e != .success { return outFail(6, "AXPress 失败 err=\(e.rawValue)") }
            return outOK(identity + "\"did\":\"press\"," + axDescribeJSON(el))
        }
        // 退到聚焦时只认盖住这个点的后代，找不到就如实报失败：抓一个别处的可聚焦元素回去，
        // 等于把这次点击悄悄换成了另一个控件，调用方还会劝模型对它敲回车。
        guard let t = focusableDescendant(el, containing: pt) else {
            return outFail(6, "该元素既没有 AXPress、这个点下面也没有能聚焦的东西（\(role.isEmpty ? "无角色" : role)）：这个点按不动")
        }
        let e = AXUIElementSetAttributeValue(t, kAXFocusedAttribute as CFString, kCFBooleanTrue)
        if e != .success { return outFail(6, "该元素既不能按也不能聚焦 err=\(e.rawValue)") }
        return outOK(identity + "\"did\":\"focus\"," + axDescribeJSON(t))
    case "focus":
        // 同 press：只在盖住这个点的后代里找，实在没有就聚焦命中元素自己，不去别处捞
        let t = focusableDescendant(el, containing: pt) ?? el
        let e = AXUIElementSetAttributeValue(t, kAXFocusedAttribute as CFString, kCFBooleanTrue)
        if e != .success { return outFail(6, "AX 聚焦失败 err=\(e.rawValue)") }
        return outOK(identity + "\"did\":\"focus\"," + axDescribeJSON(t))
    case "setval":
        guard let text = req.text else { return outFail(3, "setval 需要文本内容") }
        let e = AXUIElementSetAttributeValue(el, kAXValueAttribute as CFString, text as CFTypeRef)
        if e != .success { return outFail(6, "AX 写值失败 err=\(e.rawValue)（该元素可能只读）") }
        return outOK(identity + "\"did\":\"setval\",\"len\":\(text.count)")
    default:
        return outFail(3, "unknown ax subcommand: \(sub)")
    }
}

// MARK: - 派发：CLI 走 argv 一次性执行，serve 走 NDJSON 常驻循环

/// focusScanBudget 是全局可变量，常驻模式下每个请求都要重新给足额度
func resetPerRequestState() { focusScanBudget = 400 }

func axReqFromCLI() -> AXReq {
    var r = AXReq()
    r.sub = str(1) ?? ""
    r.pid = targetPid ?? 0
    r.wid = targetWid
    r.winX = optValue("--wx").flatMap { Double($0) }
    r.winY = optValue("--wy").flatMap { Double($0) }
    r.winW = optValue("--ww").flatMap { Double($0) }
    r.winH = optValue("--wh").flatMap { Double($0) }
    r.path = optValue("--path")
    r.expectRole = optValue("--expect-role")
    r.expectTitle = optValue("--expect-title")
    r.raise = args.contains("--raise")
    r.allowSelfDestruct = args.contains("--allow-self-destruct")
    r.maxNodes = optValue("--max").flatMap { Int($0) } ?? 2000
    return r
}

func emit(_ o: CmdOut) -> Never {
    if o.ok { ok(o.body) }
    if o.code == 7 {
        FileHandle.standardError.write(
            ("{\"ok\":false,\"error\":\"stale-target\",\"message\":"
             + jsonStr(o.message ?? o.error) + "}\n").data(using: .utf8)!)
        exit(7)
    }
    fail(o.code, o.error)
}

if cmd == "axcheck" || cmd == "elements" || cmd == "ax" {
    var r = axReqFromCLI()
    if r.pid == 0 { fail(3, "\(cmd) 需要 --pid") }
    if cmd == "ax" {
        r.x = dbl(2, "x"); r.y = dbl(3, "y")
        // setval 的内容走 stdin：argv 会出现在 ps 里
        if r.sub == "setval" {
            let data = FileHandle.standardInput.readDataToEndOfFile()
            guard let t = String(data: data, encoding: .utf8) else { fail(3, "stdin is not valid UTF-8") }
            r.text = t
        }
        emit(runAx(r))
    }
    emit(cmd == "elements" ? runElements(r) : runAxCheck(r))
}

// serve：一行一个请求的常驻 AX 服务。只接 AX 类命令——鼠标键盘是无状态的，
// 每次 spawn 一个进程没有代价；AX 不一样，Chromium 的树认发起请求的进程，
// 进程一死树就拆，于是每个动作都要重建一次（最坏 1s）。常驻之后建一次就够。
// 协议：stdin 每行 {"id":1,"cmd":"ax","sub":"press",...}，stdout 每行 {"id":1,"ok":true,...}。
if cmd == "serve" {
    residentMode = true
    setbuf(stdout, nil)
    func reply(_ id: Any, _ o: CmdOut) {
        let idStr = (id as? Int).map(String.init) ?? "null"
        var s: String
        if o.ok {
            s = "{\"id\":\(idStr),\"ok\":true" + (o.body.isEmpty ? "" : "," + o.body) + "}"
        } else if o.code == 7 {
            s = "{\"id\":\(idStr),\"ok\":false,\"exitCode\":7,\"error\":\"stale-target\","
                + "\"message\":\(jsonStr(o.message ?? o.error))}"
        } else {
            s = "{\"id\":\(idStr),\"ok\":false,\"exitCode\":\(o.code),\"error\":\(jsonStr(o.error))}"
        }
        FileHandle.standardOutput.write((s + "\n").data(using: .utf8)!)
    }
    while let line = readLine(strippingNewline: true) {
        if line.isEmpty { continue }
        guard let d = line.data(using: .utf8),
              let obj = (try? JSONSerialization.jsonObject(with: d)) as? [String: Any] else {
            FileHandle.standardOutput.write("{\"id\":null,\"ok\":false,\"error\":\"bad json\"}\n".data(using: .utf8)!)
            continue
        }
        let id = obj["id"] ?? 0
        let c = (obj["cmd"] as? String) ?? ""
        if c == "ping" { reply(id, outOK("\"pong\":true")); continue }
        if c == "quit" { exit(0) }
        var r = AXReq()
        r.sub = (obj["sub"] as? String) ?? ""
        r.pid = pid_t((obj["pid"] as? NSNumber)?.int32Value ?? 0)
        if let w = (obj["wid"] as? NSNumber)?.uint32Value, w > 0 { r.wid = CGWindowID(w) }
        r.x = (obj["x"] as? NSNumber)?.doubleValue ?? 0
        r.y = (obj["y"] as? NSNumber)?.doubleValue ?? 0
        r.winX = (obj["wx"] as? NSNumber)?.doubleValue
        r.winY = (obj["wy"] as? NSNumber)?.doubleValue
        r.winW = (obj["ww"] as? NSNumber)?.doubleValue
        r.winH = (obj["wh"] as? NSNumber)?.doubleValue
        r.path = obj["path"] as? String
        r.expectRole = obj["expectRole"] as? String
        r.expectTitle = obj["expectTitle"] as? String
        r.raise = (obj["raise"] as? Bool) ?? false
        r.allowSelfDestruct = (obj["allowSelfDestruct"] as? Bool) ?? false
        r.maxNodes = (obj["max"] as? NSNumber)?.intValue ?? 2000
        r.text = obj["text"] as? String
        if r.pid == 0 { reply(id, outFail(3, "\(c) 需要 pid")); continue }
        resetPerRequestState()
        switch c {
        case "ax":      reply(id, runAx(r))
        case "elements": reply(id, runElements(r))
        case "axcheck": reply(id, runAxCheck(r))
        default:        reply(id, outFail(3, "unknown cmd: \(c)"))
        }
    }
    exit(0)
}

// MARK: - 窗口枚举 / 窗口截图（ghost 模式：按窗口而非按屏幕，跨 Space、被遮挡也能拍）

func runBlocking<T>(_ body: @escaping (@escaping (T) -> Void) -> Void) -> T {
    let sem = DispatchSemaphore(value: 0)
    var box: T!
    body { v in box = v; sem.signal() }
    sem.wait()
    return box
}

func shareableWindows() -> [SCWindow] {
    let res: SCShareableContent? = runBlocking { done in
        SCShareableContent.getExcludingDesktopWindows(false, onScreenWindowsOnly: false) { content, _ in
            done(content)
        }
    }
    return res?.windows ?? []
}

// SCShareableContent.windows 的顺序跟 z 序毫无关系（实测与真实前后序的 Kendall tau ≈ -0.03）。
// 真正的前后关系只有 CGWindowListCopyWindowInfo 给得出：它的数组本身就是从前到后。
func zOrderIndex() -> [CGWindowID: Int] {
    var map = [CGWindowID: Int]()
    guard let list = CGWindowListCopyWindowInfo(
        [.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]] else { return map }
    for (i, info) in list.enumerated() {
        if let n = info[kCGWindowNumber as String] as? NSNumber, map[n.uint32Value] == nil {
            map[n.uint32Value] = i
        }
    }
    return map
}

// 排除宿主（Electron/终端）自身的 pid，避免 ghost 选到 Grok 自己的窗口
func excludedPids() -> Set<pid_t> {
    var s = Set<pid_t>()
    for v in (optValue("--exclude-pids") ?? "").split(separator: ",") {
        if let n = Int32(v) { s.insert(n) }
    }
    return s
}

func windowJSON(_ w: SCWindow) -> String {
    let f = w.frame
    let app = w.owningApplication
    return """
    {"windowId":\(w.windowID),"pid":\(app?.processID ?? 0),\
    "app":\(jsonStr(app?.applicationName ?? "")),"title":\(jsonStr(w.title ?? "")),\
    "x":\(Int(f.minX)),"y":\(Int(f.minY)),"w":\(Int(f.width)),"h":\(Int(f.height)),\
    "layer":\(w.windowLayer),"active":\(w.isActive)}
    """
}

// winpick front|--app <name>|--name <substr>：挑一个目标窗口，返回 pid/frame。
// front = 最前面的普通应用窗口（layer 0、够大、非宿主）。
if cmd == "winpick" {
    let excl = excludedPids()
    // --onscreen：只要当前桌面(Space)上看得见的窗口。ghost 要让用户能亲眼看着 Grok 操作，
    // 挑到一个别的 Space 或最小化的窗口就成了「无头」——用户什么都看不见。
    let onlyOnScreen = args.contains("--onscreen")
    let wins = shareableWindows().filter {
        $0.windowLayer == 0 && $0.frame.width >= 120 && $0.frame.height >= 80
        && !excl.contains($0.owningApplication?.processID ?? 0)
        && ($0.owningApplication?.applicationName.isEmpty == false)
        && (!onlyOnScreen || $0.isOnScreen)
    }
    // 前 → 后。z 序里没有的（不在当前 Space、最小化、隐藏的面板服务）一律排到最后；
    // 它们彼此之间没有前后可言，按原顺序稳定排，至少保证同样的输入给同样的结果。
    let z = zOrderIndex()
    let ordered = wins.enumerated().sorted { a, b in
        let za = z[a.element.windowID] ?? Int.max, zb = z[b.element.windowID] ?? Int.max
        return za == zb ? a.offset < b.offset : za < zb
    }.map { $0.element }
    var candidates = ordered
    if let appName = optValue("--app") {
        candidates = ordered.filter { $0.owningApplication?.applicationName.localizedCaseInsensitiveContains(appName) == true }
    } else if let sub = optValue("--name") {
        candidates = ordered.filter { ($0.title ?? "").localizedCaseInsensitiveContains(sub) }
    }
    // --list：按真实 z 序（前→后）返回多个候选，让调用方自己挑/逐个探测。
    // --app/--name 对 --list 同样生效：`--list --app Chrome` 要是把别的 App 也列出来，调用方会挑错窗口。
    if args.contains("--list") {
        let items = candidates.prefix(6).map { windowJSON($0) }.joined(separator: ",")
        FileHandle.standardOutput.write(("{\"ok\":true,\"windows\":[" + items + "]}\n").data(using: .utf8)!)
        exit(0)
    }
    // 没给筛选条件时取最前面那个：isActive 在屏上的窗口一律为 true，筛不出东西，
    // 最前面那个就是用户正在看的
    guard let w = candidates.first else { fail(5, "no matching window") }
    FileHandle.standardOutput.write(("{\"ok\":true,\"window\":" + windowJSON(w) + "}\n").data(using: .utf8)!)
    exit(0)
}

// winshot --window <id> [--out <path>]：抓单个窗口（含被遮挡部分），PNG。
// 输出图的像素尺寸就是坐标系；含 scale 便于换算逻辑点。
if cmd == "winshot" {
    guard let widStr = optValue("--window"), let wid = UInt32(widStr) else { fail(3, "missing --window") }
    guard let w = shareableWindows().first(where: { $0.windowID == wid }) else { fail(5, "window \(wid) not found (closed?)") }
    let cfg = SCStreamConfiguration()
    let scale = w.owningApplication.flatMap { _ in NSScreen.main?.backingScaleFactor } ?? 2.0
    cfg.width = Int(w.frame.width * scale)
    cfg.height = Int(w.frame.height * scale)
    cfg.showsCursor = false          // 幽灵光标由宿主叠加层画，不入截图
    cfg.ignoreShadowsSingleWindow = true
    cfg.scalesToFit = true
    let filter = SCContentFilter(desktopIndependentWindow: w)
    let img: CGImage? = runBlocking { done in
        SCScreenshotManager.captureImage(contentFilter: filter, configuration: cfg) { image, _ in done(image) }
    }
    guard let cg = img else { fail(6, "capture failed (screen recording permission? window offscreen?)") }
    let outPath = optValue("--out") ?? (NSTemporaryDirectory() + "gbd-winshot.png")
    guard let dest = CGImageDestinationCreateWithURL(
        URL(fileURLWithPath: outPath) as CFURL, "public.png" as CFString, 1, nil) else { fail(6, "png dest") }
    CGImageDestinationAddImage(dest, cg, nil)
    guard CGImageDestinationFinalize(dest) else { fail(6, "png write") }
    let json = "{\"ok\":true,\"path\":\(jsonStr(outPath)),\"imgW\":\(cg.width),\"imgH\":\(cg.height),"
        + "\"winW\":\(Int(w.frame.width)),\"winH\":\(Int(w.frame.height)),"
        + "\"originX\":\(Int(w.frame.minX)),\"originY\":\(Int(w.frame.minY)),\"scale\":\(scale)}"
    FileHandle.standardOutput.write((json + "\n").data(using: .utf8)!)
    exit(0)
}

fail(3, "unknown command: \(cmd)")
