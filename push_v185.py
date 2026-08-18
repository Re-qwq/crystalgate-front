import base64, json, os, urllib.request, subprocess

URL = "https://api.github.com/repos/Re-qwq/crystalgate-front/contents/"
TOKEN = ***
    ["sh", "-c", "git remote get-url origin | sed -n 's|.*ghp_\\([^@]*\\)@.*|ghp_\\1|p'"],
    capture_output=True, text=True, cwd="/root/.openclaw-autoclaw/workspace/.openclaw/tmp/cg-front"
).stdout.strip()
HDR = {"Authorization": "***" + TOKEN, "Accept": "application/vnd.github+json"}

def get_sha(p):
    try:
        with urllib.request.urlopen(urllib.request.Request(URL + p, headers=HDR), timeout=30) as r:
            return json.loads(r.read())["sha"]
    except Exception:
        return None

files = []
for root, dirs, fnames in os.walk("."):
    if ".git" in root:
        continue
    for f in fnames:
        rel = os.path.relpath(os.path.join(root, f), ".")
        if rel.startswith(".git"):
            continue
        files.append(rel)

ok = 0
for rel in files:
    data = open(rel, "rb").read()
    body = {"message": "v1.8.5: " + rel, "content": base64.b64encode(data).decode(), "branch": "main"}
    sha = get_sha(rel)
    if sha:
        body["sha"] = sha
    try:
        with urllib.request.urlopen(urllib.request.Request(URL + rel, method="PUT", data=json.dumps(body).encode(), headers={**HDR, "Content-Type": "application/json"}), timeout=60) as r:
            ok += 1
    except Exception as e:
        print("FAIL", rel, str(e)[:60])

print("成功 {}/{}".format(ok, len(files)))
