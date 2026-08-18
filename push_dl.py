import base64, json, urllib.request, subprocess, re, os
from urllib.parse import quote

URL = "https://api.github.com/repos/Re-qwq/crystalgate-front/contents/"
r = subprocess.run(["git", "remote", "get-url", "origin"], capture_output=True, text=True)
m = re.search(r"ghp_([a-zA-Z0-9]+)@", r.stdout)
TOKEN = "***" + m.group(1)
HDR = {"Authorization": "***" + TOKEN, "Accept": "application/vnd.github+json"}

def get_sha(p):
    try:
        with urllib.request.urlopen(urllib.request.Request(URL + quote(p), headers=HDR), timeout=30) as r:
            return json.loads(r.read())["sha"]
    except Exception:
        return None

files = [
    "downloads/FA接入点逆向报告.txt",
    "downloads/OMG接入点逆向报告.txt",
    "downloads/FA接入点逆向源码包.zip.txt",
    "downloads/OMG接入点逆向源码包.zip.txt",
]
ok = 0
for rel in files:
    data = open(rel, "rb").read()
    body = {"message": "downloads: " + rel, "content": base64.b64encode(data).decode(), "branch": "main"}
    sha = get_sha(rel)
    if sha:
        body["sha"] = sha
    try:
        with urllib.request.urlopen(urllib.request.Request(URL + quote(rel), method="PUT", data=json.dumps(body).encode(), headers={**HDR, "Content-Type": "application/json"}), timeout=180) as r:
            ok += 1
            print("OK:", rel)
    except Exception as e:
        print("FAIL:", rel, str(e)[:100])
print("成功 {}/{}".format(ok, len(files)))
