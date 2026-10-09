import fs from "node:fs";
import path from "node:path";

/** A stand-in `tool-eval-bench` (bash) that speaks the documented CLI contract. */
export const FAKE_TOOL = `#!/bin/bash
args=("$@"); jf=""; mode=run; slow=0
for ((i=0;i<\${#args[@]};i++)); do
  case "\${args[$i]}" in
    --json-file) jf="\${args[$((i+1))]}";;
    --version) echo "tool-eval-bench 9.9.9"; exit 0;;
    --probe) echo '{"ready": true}'; exit 0;;
    --dry-run) echo "TC-01"; echo "TC-02"; echo "args: \${args[*]}"; exit 0;;
    --label) label="\${args[$((i+1))]}";;
    --seed) [ "\${args[$((i+1))]}" = "999" ] && slow=1;;
  esac
done
[ -n "$TOOL_EVAL_API_KEY" ] && echo "got-key:\${#TOOL_EVAL_API_KEY}"
[ -n "$TOOL_EVAL_HEADERS" ] && echo "got-headers:$TOOL_EVAL_HEADERS"
echo "args: \${args[*]}"
echo '{"event":"server_discovered","base_url":"http://127.0.0.1:8888","backend":"vllm"}' >&2
echo '{"event":"model_auto_selected","model":"fake/model"}' >&2
for n in 1 2 3; do
  echo "{\\"event\\":\\"scenario_start\\",\\"scenario_id\\":\\"TC-0$n\\",\\"title\\":\\"Scenario $n\\",\\"category\\":\\"A\\",\\"index\\":$((n-1)),\\"total\\":3}" >&2
  if [ $slow = 1 ]; then sleep 30; else sleep 0.3; fi
  st=pass; pts=2
  [ $n = 2 ] && st=partial && pts=1
  [ $n = 3 ] && st=fail && pts=0
  echo "{\\"event\\":\\"scenario_result\\",\\"scenario_id\\":\\"TC-0$n\\",\\"status\\":\\"$st\\",\\"points\\":$pts,\\"index\\":$((n-1)),\\"total\\":3,\\"duration_seconds\\":0.3}" >&2
done
echo "a stray stderr line that is not JSON" >&2
mkdir -p "$(dirname "$jf")"
cat > "$jf" <<JSON
{"schema_version":"1","tool_eval_bench_version":"9.9.9","final_score":50,"rating":"★★★ Adequate","safety_warnings":[],"deployability":55,"responsiveness":60,"total_scenarios":3,"run_id":"fake-run-1","config":{"model":"fake/model","backend":"vllm","label":"$label"},"scores":{"final_score":50,"category_scores":[{"category":"A","percent":50}],"scenario_results":[{"scenario_id":"TC-01","status":"pass"},{"scenario_id":"TC-02","status":"partial"},{"scenario_id":"TC-03","status":"fail"}]}}
JSON
echo "{\\"event\\":\\"benchmark_complete\\",\\"json_file\\":\\"$jf\\",\\"final_score\\":50}" >&2
exit 0
`;

/** Install the fake tool where the wrapper looks for it ($HOME/.local/bin). */
export function installFakeTool(home) {
  const dir = path.join(home, ".local", "bin");
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, "tool-eval-bench");
  fs.writeFileSync(file, FAKE_TOOL, { mode: 0o755 });
  return file;
}
