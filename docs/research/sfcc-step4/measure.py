"""One fixed consensus campaign. Run only after all builds/tests have ended.

Usage: measure.py BASELINE CANDIDATE OUTPUT_DIR ARTIFACT_DIR
Native timing only. Five fast alternating pairs, then three 48-blob pairs.
"""
import hashlib
import json
import os
from pathlib import Path
import statistics
import subprocess
import sys
import time

baseline, candidate, output, artifacts = map(Path, sys.argv[1:5])
output.mkdir(parents=True, exist_ok=True)
artifacts.mkdir(parents=True, exist_ok=True)
programs = {"baseline": baseline.resolve(), "candidate": candidate.resolve()}
sha = lambda p: hashlib.sha256(p.read_bytes()).hexdigest()
manifest = {v: {"path": str(p), "sha256": sha(p), "bytes": p.stat().st_size}
            for v, p in programs.items()}
(output / "timing-artifacts.json").write_text(json.dumps(manifest, indent=2) + "\n")
rows = []
for campaign, selector, pairs, warmups in [("fast", "fast", 5, 1), ("48blob", "existing-48-blob", 3, 0)]:
    raw = output / f"{campaign}-timing.jsonl"
    if raw.exists():
        raise RuntimeError(f"Refusing to overwrite a campaign: {raw}")
    with raw.open("w") as stream:
        for pair in range(pairs):
            order = ["baseline", "candidate"] if pair % 2 == 0 else ["candidate", "baseline"]
            pair_rows = {}
            for position, version in enumerate(order):
                env = dict(os.environ)
                env.pop("SFCC_COST_EVIDENCE", None)
                env.pop("SFCC_COST_MESH_ONLY", None)
                evidence = artifacts / campaign / str(pair) / version
                if campaign == "48blob":
                    env["SFCC_COST_EVIDENCE"] = str(evidence)
                    env["SFCC_COST_MESH_ONLY"] = "1"
                print(f"{campaign} pair {pair + 1}/{pairs} {version} starting", flush=True)
                started = time.time()
                run = subprocess.run([str(programs[version]), selector, "1", str(warmups)],
                                     check=True, capture_output=True, text=True, env=env)
                (artifacts / f"{campaign}-{pair}-{version}.stderr").write_text(run.stderr)
                current = []
                for line in run.stdout.splitlines():
                    row = json.loads(line)
                    assert "elapsed_ms" in row and not row["counters"] and row["decided"] is None
                    row = {"version": version, "pair": pair, "position": position,
                           "warmups_per_scene": warmups, "started_epoch": started, **row}
                    if campaign == "48blob":
                        row["output_hashes"] = {p.name: sha(p) for p in sorted((evidence / row["scene"]).iterdir())}
                    stream.write(json.dumps(row) + "\n")
                    stream.flush()
                    rows.append(row)
                    current.append(row)
                pair_rows[version] = current
                print(f"{campaign} pair {pair + 1}/{pairs} {version} ended ({time.time()-started:.1f}s)", flush=True)
            excluded = {"version", "pair", "position", "started_epoch", "elapsed_ms", "phase_ms"}
            normalized = lambda row: {k: v for k, v in row.items() if k not in excluded}
            assert list(map(normalized, pair_rows["baseline"])) == list(map(normalized, pair_rows["candidate"]))
summary = []
for scene in sorted({r["scene"] for r in rows}):
    values = {v: sorted([r for r in rows if r["scene"] == scene and r["version"] == v], key=lambda r:r["pair"])
              for v in programs}
    b, c = [[r["elapsed_ms"] for r in values[v]] for v in ["baseline", "candidate"]]
    paired = [(y/x - 1)*100 for x,y in zip(b,c)]
    summary.append({"scene": scene, "baseline_ms": b, "candidate_ms": c,
        "baseline_median_ms": statistics.median(b), "candidate_median_ms": statistics.median(c),
        "median_change_percent": (statistics.median(c)/statistics.median(b)-1)*100,
        "paired_changes_percent": paired, "paired_median_percent": statistics.median(paired),
        "baseline_range_ms": [min(b),max(b)], "candidate_range_ms": [min(c),max(c)]})
(output / "timing-summary.json").write_text(json.dumps(summary, indent=2)+"\n")
print(json.dumps(summary, indent=2), flush=True)
