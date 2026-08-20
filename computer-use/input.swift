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

func mouseButton(_ s: String?) -> (CGMouseButton, CGEventType, CGEventType) {
    switch (s ?? "left").lowercased() {
    case "right":  return (.right, .rightMouseDown, .rightMouseUp)
    case "middle": return (.center, .otherMouseDown, .otherMouseUp)
    default:       return (.left, .leftMouseDown, .leftMouseUp)
    }
}

let src = CGEventSource(stateID: .combinedSessionState)

func post(_ e: CGEvent?) {
    e?.post(tap: .cghidEventTap)
}

func requirePostAccess() {
    if !CGPreflightPostEventAccess() {
        _ = CGRequestPostEventAccess()
        fail(2, "accessibility permission not granted (CGEventPost would be a silent no-op)")
    }
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


if cmd == "move" {
    let x = dbl(1, "x"), y = dbl(2, "y")
    CGWarpMouseCursorPosition(CGPoint(x: x, y: y))
    if CGPreflightPostEventAccess() {
        post(CGEvent(mouseEventSource: src, mouseType: .mouseMoved,
                     mouseCursorPosition: CGPoint(x: x, y: y), mouseButton: .left))
    }
    ok("\"x\":\(x),\"y\":\(y)")
}

// MARK: - click / down / up

if cmd == "click" || cmd == "down" || cmd == "up" {
    requirePostAccess()
    let x = dbl(1, "x"), y = dbl(2, "y")
    let (btn, downT, upT) = mouseButton(str(3))
    let pt = CGPoint(x: x, y: y)
    CGWarpMouseCursorPosition(pt)

    func mk(_ t: CGEventType, click: Int64) -> CGEvent? {
        let e = CGEvent(mouseEventSource: src, mouseType: t, mouseCursorPosition: pt, mouseButton: btn)
        if click > 0 { e?.setIntegerValueField(.mouseEventClickState, value: click) }
        return e
    }

    if cmd == "down" { post(mk(downT, click: 1)); ok() }
    if cmd == "up"   { post(mk(upT,   click: 1)); ok() }

    let count = min(10, max(1, Int64(str(4).flatMap { Int($0) } ?? 1)))
    for c in 1...count {
        post(mk(downT, click: c))
        post(mk(upT,   click: c))
    }
    ok("\"button\":\"\((str(3) ?? "left"))\",\"count\":\(count)")
}


if cmd == "drag" || cmd == "moveto-drag" {
    requirePostAccess()
    let x1 = dbl(1, "x1"), y1 = dbl(2, "y1"), x2 = dbl(3, "x2"), y2 = dbl(4, "y2")
    let (btn, downT, upT) = mouseButton(str(5))
    let steps = max(1, Int(str(6).flatMap { Int($0) } ?? 20))
    let dragT: CGEventType = btn == .left ? .leftMouseDragged
        : (btn == .right ? .rightMouseDragged : .otherMouseDragged)

    CGWarpMouseCursorPosition(CGPoint(x: x1, y: y1))
    let down = CGEvent(mouseEventSource: src, mouseType: downT,
                       mouseCursorPosition: CGPoint(x: x1, y: y1), mouseButton: btn)
    down?.setIntegerValueField(.mouseEventClickState, value: 1)
    post(down)
    usleep(30_000)
    for s in 1...steps {
        let t = Double(s) / Double(steps)
        let px = x1 + (x2 - x1) * t
        let py = y1 + (y2 - y1) * t
        let e = CGEvent(mouseEventSource: src, mouseType: dragT,
                        mouseCursorPosition: CGPoint(x: px, y: py), mouseButton: btn)
        e?.setIntegerValueField(.mouseEventClickState, value: 1)
        post(e)
        usleep(8_000)
    }
    let up = CGEvent(mouseEventSource: src, mouseType: upT,
                     mouseCursorPosition: CGPoint(x: x2, y: y2), mouseButton: btn)
    up?.setIntegerValueField(.mouseEventClickState, value: 1)
    post(up)
    ok()
}


if cmd == "scroll" {
    requirePostAccess()
    let x = dbl(1, "x"), y = dbl(2, "y")
    func clampWheel(_ v: Double) -> Int32 {
        if v.isNaN { return 0 }
        return Int32(max(-10000, min(10000, v.rounded())))
    }
    let dx = clampWheel(dbl(3, "dx")), dy = clampWheel(dbl(4, "dy"))
    CGWarpMouseCursorPosition(CGPoint(x: x, y: y))
    let e = CGEvent(scrollWheelEvent2Source: src, units: .line, wheelCount: 2,
                    wheel1: dy, wheel2: dx, wheel3: 0)
    post(e)
    ok("\"dx\":\(dx),\"dy\":\(dy)")
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
    for scalar in text.unicodeScalars {
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

fail(3, "unknown command: \(cmd)")
