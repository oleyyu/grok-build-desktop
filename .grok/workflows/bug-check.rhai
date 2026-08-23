let meta = #{
    name: "bug-check",
    description: "Scan Grok Build Desktop for real bugs, adversarially verify, write a report",
    when_to_use: "Hunt correctness, IPC, computer-use, and secret-handling bugs in this Electron app",
    phases: [
        #{ title: "Scan", detail: "five read-only hunters in parallel" },
        #{ title: "Verify", detail: "one skeptic per finding, fail closed" },
        #{ title: "Report", detail: "synthesize confirmed bugs into markdown" },
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

let report_schema = #{
    "type": "object",
    "required": ["headline", "report"],
    "properties": #{
        "headline": #{ "type": "string" },
        "report": #{ "type": "string" },
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
    if p == "preload.cjs" || p == "package.json" { return true; }
    if p.index_of("main/") == 0 { return true; }
    if p.index_of("renderer/") == 0 { return true; }
    if p.index_of("computer-use/") == 0 { return true; }
    if p.index_of("home/") == 0 { return true; }
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
        id: "main",
        dirs: "main/engine.js, main/acp-client.js, main/ipc.js, main/main.js, main/sessions-store.js, main/stay-awake.js, main/computer-use.js, main/engine-opts.js",
        focus: "Electron main-process correctness: ACP session lifecycle, engine spawn/restart, prompt queue, stay-awake, error handling, races, and state that can desync from the renderer.",
    },
    #{
        id: "renderer",
        dirs: "renderer/app.js, renderer/index.html, renderer/i18n.js, renderer/app.css, renderer/dsh-shell.css",
        focus: "Renderer UI state bugs: home vs chat, queue, permission UI, model/effort, thinking, settings, i18n missing keys, and events that assume IPC results the main process does not send.",
    },
    #{
        id: "ipc",
        dirs: "preload.cjs, main/ipc.js, renderer/app.js, main/main.js",
        focus: "IPC contract bugs: contextBridge vs ipcMain handlers, invoke/handle name mismatches, missing payloads, unsanitized channels, and renderer calling APIs that preload never exposed.",
    },
    #{
        id: "cu",
        dirs: "computer-use/server.mjs, computer-use/input.swift, computer-use/plugin.json, main/computer-use.js, main/cu-overlay.js, renderer/cu-banner.html, renderer/cu-cursor.html",
        focus: "Computer-use bugs: overlay vs screenshots, independent pointer, target-window, permissions, injection into new sessions only, Grok 4.6 gating, and Swift/Node protocol mismatches.",
    },
    #{
        id: "secrets",
        dirs: "main/mask-secrets.js, main/account.js, main/settings.js, main/stats.js, home/settings.yaml, main/log.js, main/paths.js",
        focus: "Secret handling and settings: tokens in logs, .accounts.json permissions, settings.yaml vs credentials, redaction gaps, and stats leaking auth material.",
    },
];

phase("Scan");
let jobs = [];
for a in areas {
    let p = "You are a bug hunter for Grok Build Desktop, an unofficial macOS Electron shell around the grok CLI over ACP. ";
    p += "Inspect ONLY these paths: " + a.dirs + ". ";
    p += "Focus: " + a.focus + " ";
    p += "Use read_file, grep, and list_dir. Do not answer from memory. ";
    p += "Read at least three of the listed files all the way through before reporting. ";
    p += "Also run grep across those files for TODO, FIXME, catch (empty), and ipc channel names. ";
    p += "Report at most 6 concrete, reproducible bugs as {file, issue, severity, area}. ";
    p += "severity must be one of high, medium, low. area must be \"" + a.id + "\". ";
    p += "file must be a real repo-relative path you opened (main/, renderer/, computer-use/, home/, preload.cjs, package.json). ";
    p += "issue must name the broken behavior and the code evidence, not a style nit. ";
    p += "Do not report missing tests, missing comments, or speculative future bugs. ";
    p += "An empty findings array is valid ONLY after you have actually read the files and found no real bugs.";
    jobs.push(#{
        prompt: p,
        label: "scan:" + a.id,
        capability_mode: "read-only",
        output_schema: findings_schema,
    });
}
log("scanning " + jobs.len().to_string() + " areas in parallel");
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
            if seen[key] != () {
                continue;
            }
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
    let empty_md = "# Grok Build Desktop Bug 检查\n\n扫描了 main / renderer / IPC / computer-use / secrets 五个区域，没有可提交的确认问题。\n";
    let empty_path = write_scratch_file("bug-check.md", empty_md);
    complete(#{
        path: empty_path,
        headline: "未发现确认的 bug",
        confirmed: 0,
        scanned: findings.len(),
        report: empty_md,
    });
}

phase("Verify");
let vjobs = [];
let vidx = 0;
for f in findings {
    let encoded = json_encode(f);
    let vp = "You are an adversarial skeptic. A bug hunter claimed this finding in Grok Build Desktop. ";
    vp += "Independently read the cited file and nearby call sites with read_file and grep. ";
    vp += "Do not trust the hunter. Set real=true ONLY if you personally inspected the code and the broken behavior is real. ";
    vp += "Otherwise set real=false. Missing evidence means real=false. ";
    vp += "evidence must quote the concrete code (function name, branch, or mismatch) you opened. ";
    vp += "Finding JSON: " + encoded;
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
            log("verify real=true but empty evidence, rejected: " + f.file);
        }
    } else {
        log("unverified: " + f.file);
    }
    vi += 1;
}
log(confirmed.len().to_string() + "/" + findings.len().to_string() + " findings survived verification");

phase("Report");
let payload = json_encode(#{
    confirmed: confirmed,
    unverified_count: findings.len() - confirmed.len(),
    scan_areas: 5,
});
let rp = "Write a Chinese markdown bug report for Grok Build Desktop from ONLY the verified findings JSON below. ";
rp += "Do not invent bugs. If confirmed is empty, say the scan found nothing that survived verification. ";
rp += "You MAY quickly re-read 1-2 cited files with read_file if a finding looks thin. ";
rp += "headline: one Chinese line. report: markdown with 概述, then a heading per confirmed bug (severity, file, 问题, 证据), then 建议下一步. ";
rp += "Keep the report under 800 Chinese characters per bug. Input JSON: " + payload;

let syn = agent(rp, #{
    label: "report",
    capability_mode: "read-only",
    output_schema: report_schema,
});

let headline = confirmed.len().to_string() + " 个确认 bug";
let report = "# Grok Build Desktop Bug 检查\n\n";
if syn != () && syn.success && syn.output != () {
    if syn.output.headline != () { headline = syn.output.headline; }
    if syn.output.report != () { report = syn.output.report; }
} else {
    report += "综合报告生成失败。已确认 " + confirmed.len().to_string() + " 条。\n\n";
    report += payload;
    report += "\n";
}

let out_path = write_scratch_file("bug-check.md", report);
log("wrote " + out_path);
complete(#{
    path: out_path,
    headline: headline,
    confirmed: confirmed.len(),
    scanned: findings.len(),
    report: report,
});
