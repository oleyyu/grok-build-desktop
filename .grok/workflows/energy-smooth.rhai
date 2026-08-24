let meta = #{
    name: "energy-smooth",
    description: "Audit Grok Build Desktop for idle battery drain and UI jank; verify each finding",
    when_to_use: "Check whether the Electron shell wastes battery or stutters, and list remaining safe optimizations",
    phases: [
        #{ title: "Scan", detail: "four read-only hunters: idle power, timers, streaming jank, GPU" },
        #{ title: "Verify", detail: "one skeptic per finding, fail closed" },
        #{ title: "Report", detail: "prioritized remaining work" },
    ],
};

let findings_schema = #{
    "type": "object",
    "required": ["findings"],
    "properties": #{
        "findings": #{
            "type": "array",
            "maxItems": 6,
            "items": #{
                "type": "object",
                "required": ["file", "issue", "severity", "area"],
                "properties": #{
                    "file": #{ "type": "string" },
                    "issue": #{ "type": "string" },
                    "severity": #{ "type": "string" },
                    "area": #{ "type": "string" },
                },
            },
        },
    },
};

let verdict_schema = #{
    "type": "object",
    "required": ["real", "reason", "evidence"],
    "properties": #{
        "real": #{ "type": "boolean" },
        "reason": #{ "type": "string" },
        "evidence": #{ "type": "string" },
    },
};

fn trimmed(s) {
    if type_of(s) == "string" {
        s.trim();
        s
    } else {
        ""
    }
}

fn path_in_scope(p) {
    if type_of(p) != "string" { return false; }
    if p == "package.json" || p == "preload.cjs" { return true; }
    if p.index_of("main/") == 0 { return true; }
    if p.index_of("renderer/") == 0 { return true; }
    if p.index_of("computer-use/") == 0 { return true; }
    false
}

fn norm_severity(s) {
    let v = trimmed(s);
    if v == "high" || v == "medium" || v == "low" { return v; }
    "medium"
}

const MAX_FINDINGS = 8;

let areas = [
    #{
        id: "idle-power",
        dirs: "package.json, main/stay-awake.js, main/main.js, main/settings.js, main/engine.js",
        focus: "Idle battery: NSAppSleepDisabled, Chromium command-line switches, backgroundThrottling, powerSaveBlocker, caffeinate, keepAwake. Report only issues that still drain power when no turn is running.",
    },
    #{
        id: "timers",
        dirs: "renderer/app.js, renderer/cu-banner.html, renderer/cu-cursor.html, main/account.js, main/cu-overlay.js",
        focus: "Always-on setInterval/setTimeout/rAF loops, login polls, hero typewriter, workflow panel ticks, tsReconcile. Report timers that fire while the UI is idle or document.hidden.",
    },
    #{
        id: "jank",
        dirs: "renderer/app.js, renderer/app.css, renderer/dsh-shell.css, renderer/index.html",
        focus: "Streaming and panel smoothness: innerHTML rebuilds on a timer, 133ms status-line renders, unbatched markdown, layout thrash, missing rAF batching. Skip style nits.",
    },
    #{
        id: "gpu",
        dirs: "main/main.js, main/cu-overlay.js, renderer/app.css, renderer/dsh-shell.css, renderer/theme.css, renderer/cu-banner.html",
        focus: "GPU cost: transparent windows, vibrancy, infinite CSS animations that run while idle, extra BrowserWindows left alive after computer-use ends.",
    },
];

phase("Scan");
let jobs = [];
for a in areas {
    let p = "You are auditing Grok Build Desktop, an unofficial macOS Electron app wrapping the grok CLI. ";
    p += "Goal: remaining battery drain and UI jank AFTER recent energy work (App Nap re-enabled, renderer throttled when idle, CSS spinner, gated tsReconcile, workflow panel live-tick). ";
    p += "Inspect ONLY these paths: " + a.dirs + ". ";
    p += "Focus: " + a.focus + " ";
    p += "Use read_file and grep. Do not answer from memory. Read the listed files before reporting. ";
    p += "Grep for setInterval, requestAnimationFrame, innerHTML, NSAppSleep, backgroundThrottling, caffeinate, animation, transparent. ";
    p += "Report at most 6 remaining, concrete optimizations as {file, issue, severity, area}. ";
    p += "severity: high = idle battery or visible jank; medium = only-while-busy cost that is still wasteful; low = polish. ";
    p += "area must be \"" + a.id + "\". file must be a real repo-relative path you opened. ";
    p += "Do not report work already done (NSAppSleepDisabled removed, command-line unthrottle switches removed, tsReconcile gated, 133ms spinner gone). ";
    p += "An empty findings array is valid ONLY after you have actually read the files.";
    jobs.push(#{
        prompt: p,
        label: "scan:" + a.id,
        capability_mode: "read-only",
        output_schema: findings_schema,
    });
}
log("scanning " + jobs.len().to_string() + " energy/smoothness areas");
let scan_results = parallel(jobs);

let findings = [];
let seen = #{};
let dropped_scope = 0;
let dropped_cap = 0;
let scan_i = 0;
for r in scan_results {
    if r == () || !r.success || r.output == () || r.output.findings == () {
        log("scan failed or empty: " + areas[scan_i].id);
    } else {
        for f in r.output.findings {
            if f == () { continue; }
            let file = trimmed(f.file);
            let issue = trimmed(f.issue);
            if file == "" || issue == "" {
                dropped_scope += 1;
                continue;
            }
            if !path_in_scope(file) {
                dropped_scope += 1;
                log("dropped out-of-scope: " + file);
                continue;
            }
            let key = fingerprint(file + "|" + issue);
            if seen[key] != () { continue; }
            if findings.len() >= MAX_FINDINGS {
                dropped_cap += 1;
                continue;
            }
            seen[key] = true;
            let area_id = trimmed(f.area);
            if area_id == "" { area_id = areas[scan_i].id; }
            findings.push(#{
                file: file,
                issue: issue,
                severity: norm_severity(f.severity),
                area: area_id,
            });
        }
    }
    scan_i += 1;
}
if dropped_scope > 0 { log("dropped out-of-scope findings: " + dropped_scope.to_string()); }
if dropped_cap > 0 { log("dropped over cap: " + dropped_cap.to_string()); }
log("unique in-scope findings: " + findings.len().to_string());

if findings.len() == 0 {
    phase("Report");
    let empty_md = "# Energy and smoothness\n\nNo remaining confirmed idle-battery or jank issues after the current changes.\n";
    let empty_path = write_scratch_file("energy-smooth.md", empty_md);
    complete(#{
        path: empty_path,
        headline: "No remaining confirmed energy/jank issues",
        confirmed: 0,
        report: empty_md,
    });
}

phase("Verify");
let vjobs = [];
let vidx = 0;
for f in findings {
    let encoded = json_encode(f);
    let vp = "You are an adversarial skeptic for a battery/smoothness audit of Grok Build Desktop. ";
    vp += "Independently read the cited file with read_file/grep. Do not trust the hunter. ";
    vp += "Set real=true ONLY if the wasteful behavior still exists in the current code. ";
    vp += "If the code already gates the timer/throttle on busy or visibility, set real=false. ";
    vp += "evidence must quote the concrete code you opened. Finding JSON: " + encoded;
    vjobs.push(#{
        prompt: vp,
        label: "verify:" + vidx.to_string(),
        capability_mode: "read-only",
        output_schema: verdict_schema,
    });
    vidx += 1;
}
let verdicts = parallel(vjobs);

let confirmed = [];
let vi = 0;
for v in verdicts {
    let f = findings[vi];
    if v != () && v.success && v.output != () && v.output.real == true {
        let ev = trimmed(v.output.evidence);
        if ev != "" {
            confirmed.push(#{
                file: f.file,
                issue: f.issue,
                severity: f.severity,
                area: f.area,
                reason: trimmed(v.output.reason),
                evidence: ev,
            });
        } else {
            log("verify real but empty evidence: " + f.file);
        }
    }
    vi += 1;
}
log(confirmed.len().to_string() + "/" + findings.len().to_string() + " findings survived verification");

phase("Report");
let md = "# Energy and smoothness — remaining issues\n\n";
md += "Confirmed after adversarial verify: " + confirmed.len().to_string() + " of " + findings.len().to_string() + ".\n\n";
for c in confirmed {
    md += "## " + c.severity + " — `" + c.file + "`\n\n";
    md += c.issue + "\n\n";
    md += c.reason + "\n\n";
    md += "Evidence: " + c.evidence + "\n\n";
}
if confirmed.len() == 0 {
    md += "Nothing confirmed. The idle-power and jank fixes already in tree look sufficient.\n";
}
let report_path = write_scratch_file("energy-smooth.md", md);
complete(#{
    path: report_path,
    headline: confirmed.len().to_string() + " remaining energy/jank issues",
    confirmed: confirmed.len(),
    scanned: findings.len(),
    report: md,
});
