let meta = #{
    name: "sample-multi-agent",
    description: "Sample: three area scouts in parallel, then one synthesizer",
    when_to_use: "Demo a multi-agent workflow against this Grok Build Desktop repo",
    phases: [
        #{ title: "Scout", detail: "three read-only area scouts in parallel" },
        #{ title: "Synthesize", detail: "one agent writes a short snapshot" },
    ],
};

let scout_schema = #{
    "type": "object",
    "required": ["area", "purpose", "key_files", "risk"],
    "properties": #{
        "area": #{ "type": "string" },
        "purpose": #{ "type": "string" },
        "key_files": #{
            "type": "array",
            "maxItems": 6,
            "items": #{ "type": "string" },
        },
        "risk": #{ "type": "string" },
    },
};

let snap_schema = #{
    "type": "object",
    "required": ["headline", "report"],
    "properties": #{
        "headline": #{ "type": "string" },
        "report": #{ "type": "string" },
    },
};

phase("Scout");
let areas = [
    #{
        id: "main",
        dir: "main/",
        hint: "Electron main process: engine, ACP, IPC, settings, sessions",
    },
    #{
        id: "renderer",
        dir: "renderer/",
        hint: "Renderer UI: DSH shell, chat, sessions, theme",
    },
    #{
        id: "computer-use",
        dir: "computer-use/",
        hint: "Computer-use plugin: Swift input plus local server",
    },
];

let jobs = [];
for a in areas {
    let p = "You are scouting the Grok Build Desktop repo (Electron + Grok ACP). ";
    p += "Inspect ONLY the directory `" + a.dir + "` (" + a.hint + "). ";
    p += "Use list_dir, read_file, and grep — do not answer from memory. ";
    p += "Read package.json and at least two source files in that directory before answering. ";
    p += "Return JSON: area (short name), purpose (1-2 sentences of what this area does), ";
    p += "key_files (up to 6 real paths you opened), risk (the single most important coupling or failure mode you actually saw). ";
    p += "Empty key_files is valid only after you listed the directory and found no source files.";
    jobs.push(#{
        prompt: p,
        label: "scout:" + a.id,
        capability_mode: "read-only",
        output_schema: scout_schema,
    });
}
log("scouting " + jobs.len().to_string() + " areas in parallel");
let results = parallel(jobs);

let briefs = [];
let idx = 0;
for r in results {
    if r != () && r.success && r.output != () {
        briefs.push(r.output);
    } else {
        log("scout failed: " + areas[idx].id);
    }
    idx += 1;
}

phase("Synthesize");
let brief_json = json_encode(briefs);
let sp = "Synthesize a short architecture snapshot of Grok Build Desktop from these scout briefs. ";
sp += "Do not invent files you cannot confirm. You MAY quickly verify 1-2 paths with read_file if a brief looks thin. ";
sp += "Input briefs (JSON): " + brief_json + " ";
sp += "Return headline (one line) and report (markdown: overview, how the three areas connect, one risk). Keep the report under 400 words.";

let syn = agent(sp, #{
    label: "synthesize",
    capability_mode: "read-only",
    output_schema: snap_schema,
});

let headline = "Sample multi-agent run finished";
let report = "# Grok Build Desktop snapshot\n\n";
if syn != () && syn.success && syn.output != () {
    if syn.output.headline != () { headline = syn.output.headline; }
    if syn.output.report != () { report = syn.output.report; }
} else {
    report += "Synthesizer did not return a report. Scout count: " + briefs.len().to_string() + ".\n\n";
    report += brief_json;
    report += "\n";
}

let out_path = write_scratch_file("snapshot.md", report);
log("wrote " + out_path);
complete(#{
    path: out_path,
    headline: headline,
    scouts: briefs.len(),
    report: report,
});
