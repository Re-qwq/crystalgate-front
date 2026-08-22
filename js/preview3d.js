/* CrystalGate 3D 建筑预览 (Three.js r128 + InstancedMesh)
 * 暴露 window.CGPreview3D = { open(data, assetsBase), close() }
 *
 * data 结构 (来自 /api/parser/preview):
 *   size: {width, height, length}
 *   name_ids: {name: id}
 *   blocks: [x,y,z,id, ...]
 */
(function () {
    "use strict";

    var ASSETS = "/assets/textures";
    var ATLAS_IMG = ASSETS + "/atlas.png";
    var ATLAS_JSON = ASSETS + "/block_textures.json";

    var container = null, renderer = null, scene = null, camera = null, controls = null;
    var atlasTex = null, atlasMeta = null, blockMeta = null;
    var currentGroup = null;
    var loadSeq = 0;

    /* ---- 工具: 方块名 -> 形状 ---- */
    function shapeOf(name) {
        if (!blockMeta) return "full";
        var m = blockMeta[name] || blockMeta[name.split(":")[1]] || blockMeta[name.split("[")[0]];
        if (m && m.shape) return m.shape;
        var fallback = blockMeta["minecraft:stone"];
        return fallback ? fallback.shape : "full";
    }

    /* ---- 工具: 从 atlas 裁出单个瓦片 Canvas ---- */
    function tileCanvas(index) {
        var cols = atlasMeta.cols || 16;
        var ts = atlasMeta.tile || 16;
        var c = document.createElement("canvas");
        c.width = ts; c.height = ts;
        var ctx = c.getContext("2d");
        var r = Math.floor(index / cols), col = index % cols;
        ctx.drawImage(atlasTex.image, col * ts, r * ts, ts, ts, 0, 0, ts, ts);
        return c;
    }

    /* ---- 几何生成 ---- */
    function geoFor(shape, opts) {
        var g;
        switch (shape) {
            case "slab":
                g = new THREE.BoxGeometry(1, 0.5, 1);
                g.translate(0, 0.25, 0);
                return g;
            case "flat":
                g = new THREE.BoxGeometry(1, 0.0625, 1);
                g.translate(0, 0.03125, 0);
                return g;
            case "torch":
                g = new THREE.CylinderGeometry(0.08, 0.08, 0.6, 6);
                g.translate(0, 0.3, 0);
                return g;
            case "thin":
                g = new THREE.BoxGeometry(0.15, 1, 0.15);
                return g;
            case "cross": {
                // 交叉双面片
                g = new THREE.BufferGeometry();
                var h = 0.8;
                var p = [
                    // 面片1
                    -0.5, 0, 0, 0.5, 0, 0, 0.5, h, 0, -0.5, 0, 0, 0.5, h, 0, -0.5, h, 0,
                    // 面片2
                    0, 0, -0.5, 0, 0, 0.5, 0, h, 0.5, 0, 0, -0.5, 0, h, 0.5, 0, h, -0.5,
                ];
                var pos = new Float32Array(p);
                var uv = new Float32Array([
                    0, 1, 1, 1, 1, 0, 0, 1, 1, 0, 0, 0,
                    0, 1, 1, 1, 1, 0, 0, 1, 1, 0, 0, 0,
                ]);
                g.setAttribute("position", new THREE.BufferAttribute(pos, 3));
                g.setAttribute("uv", new THREE.BufferAttribute(uv, 2));
                g.computeVertexNormals();
                return g;
            }
            case "fence": {
                // 立柱 + 上下横杆
                g = new THREE.Group();
                var post = new THREE.BoxGeometry(0.2, 1, 0.2);
                var rail = new THREE.BoxGeometry(0.8, 0.12, 0.8);
                var m = new THREE.Matrix4();
                var p1 = new THREE.Mesh(post); p1.position.set(-0.4, 0.5, 0); g.add(p1);
                var p2 = new THREE.Mesh(post); p2.position.set(0.4, 0.5, 0); g.add(p2);
                var p3 = new THREE.Mesh(post); p3.position.set(0, 0.5, -0.4); g.add(p3);
                var p4 = new THREE.Mesh(post); p4.position.set(0, 0.5, 0.4); g.add(p4);
                var r1 = new THREE.Mesh(rail); r1.position.set(0, 0.7, 0); g.add(r1);
                var r2 = new THREE.Mesh(rail); r2.position.set(0, 0.35, 0); g.add(r2);
                g.scale.set(1, 1, 1);
                return g;
            }
            case "door":
                g = new THREE.BoxGeometry(0.9, 1, 0.12);
                g.translate(0, 0.5, 0);
                return g;
            case "painting":
                g = new THREE.BoxGeometry(1, 1, 0.08);
                g.translate(0, 0.5, 0);
                return g;
            case "full":
            default:
                g = new THREE.BoxGeometry(1, 1, 1);
                g.translate(0, 0.5, 0);
                return g;
        }
    }

    /* ---- 构建场景 ---- */
    function build(data, root) {
        var size = data.size;
        var w = size.width, h = size.height, l = size.length;
        var names = Object.keys(data.name_ids);
        var blocks = data.blocks;
        var n = blocks.length / 4;

        // 按 (name, shape) 分组
        var groups = {};
        for (var i = 0; i < n; i++) {
            var id = blocks[i * 4 + 3];
            var name = names[id];
            var key = name + "|" + shapeOf(name);
            if (!groups[key]) groups[key] = { name: name, shape: shapeOf(name), pts: [] };
            groups[key].pts.push([blocks[i * 4], blocks[i * 4 + 1], blocks[i * 4 + 2]]);
        }

        var keys = Object.keys(groups);
        var maxDim = Math.max(w, h, l);
        var half = { x: w / 2, y: h / 2, z: l / 2 };

        keys.forEach(function (key, gi) {
            var grp = groups[key];
            var name = grp.name;
            var idx = (blockMeta && (blockMeta[name] || blockMeta[name.split(":")[1]] || blockMeta[name.split("[")[0]])) ? (blockMeta[name] || blockMeta[name.split(":")[1]] || blockMeta[name.split("[")[0]]).atlas : 0;
            var tex = new THREE.CanvasTexture(tileCanvas(idx));
            tex.magFilter = THREE.NearestFilter;
            tex.minFilter = THREE.NearestFilter;

            var shape = grp.shape;
            var material;
            if (name.indexOf("glass") !== -1) {
                material = new THREE.MeshLambertMaterial({ map: tex, transparent: true, opacity: 0.55, side: THREE.DoubleSide });
            } else {
                material = new THREE.MeshLambertMaterial({ map: tex });
            }

            var obj = new THREE.Object3D();
            if (shape === "fence") {
                // 每组 fence 用 Object3D 实例 (数量通常少)
                grp.pts.forEach(function (pt) {
                    var inst = geoFor("fence", null).clone();
                    inst.traverse(function (c) {
                        if (c.isMesh) c.material = material;
                    });
                    inst.position.set(pt[0] - half.x, pt[1], pt[2] - half.z);
                    root.add(inst);
                });
                return;
            }

            var geo = geoFor(shape, null);
            var im = new THREE.InstancedMesh(geo, material, grp.pts.length);
            var mat = new THREE.Matrix4();
            var pos = new THREE.Vector3(), quat = new THREE.Quaternion(), scl = new THREE.Vector3(1, 1, 1);
            grp.pts.forEach(function (pt, k) {
                pos.set(pt[0] - half.x, pt[1], pt[2] - half.z);
                mat.compose(pos, quat, scl);
                im.setMatrixAt(k, mat);
            });
            im.instanceMatrix.needsUpdate = true;
            im.castShadow = false;
            root.add(im);
        });
    }

    /* ---- 打开预览 ---- */
    function open(data) {
        close();
        var seq = ++loadSeq;

        container = document.createElement("div");
        container.id = "cg-preview3d";
        container.style.cssText = "position:fixed;inset:0;z-index:9999;background:rgba(8,12,18,0.96);display:flex;flex-direction:column;font-family:Menlo,Consolas,monospace;color:#cfe8d0;";
        container.innerHTML =
            '<div style="flex:0 0 auto;display:flex;align-items:center;justify-content:space-between;padding:10px 16px;border-bottom:1px solid rgba(120,255,160,0.25);background:rgba(0,0,0,0.35);">' +
            '  <div style="font-size:15px;font-weight:bold;color:#8aff9e;">3D 预览: ' + esc(data.filename) + '</div>' +
            '  <div style="font-size:13px;color:#8fa;opacity:0.85;">' + data.total + ' 方块 · ' + Object.keys(data.name_ids).length + ' 种 · 尺寸 ' + data.size.width + '×' + data.size.height + '×' + data.size.length + ' · 拖动旋转 / 滚轮缩放</div>' +
            '  <button id="cg-preview3d-close" style="background:rgba(200,60,60,0.2);border:1px solid rgba(255,120,120,0.5);color:#ffb0b0;padding:4px 14px;cursor:pointer;border-radius:4px;font-size:13px;">关闭 [Esc]</button>' +
            '</div>' +
            '<div id="cg-preview3d-canvas" style="flex:1;position:relative;"></div>' +
            '<div style="flex:0 0 auto;padding:4px 16px;font-size:12px;color:#6a8f70;border-top:1px solid rgba(120,255,160,0.15);">点击 [Esc] 或右上角关闭返回终端 · 红色为特殊形状方块(火把/红石粉/画/栅栏等)</div>';

        document.body.appendChild(container);
        document.getElementById("cg-preview3d-close").addEventListener("click", close);

        var escHandler = function (e) { if (e.key === "Escape") close(); };
        document.addEventListener("keydown", escHandler);
        container._escHandler = escHandler;

        var canvasHost = document.getElementById("cg-preview3d-canvas");

        // 加载 atlas + meta (带缓存)
        var ensureAssets = function (cb) {
            if (atlasTex && atlasMeta && blockMeta) { cb(); return; }
            var jsonUrl = ATLAS_JSON;
            fetch(jsonUrl).then(function (r) { return r.json(); }).then(function (meta) {
                atlasMeta = meta;
                blockMeta = meta.blocks;
                var loader = new THREE.TextureLoader();
                atlasTex = loader.load(ATLAS_IMG, function () { cb(); });
            }).catch(function () {
                // 兜底: 无贴图时纯色
                blockMeta = { "minecraft:stone": { atlas: 0, shape: "full", color: "#7d7d7d" } };
                atlasMeta = { cols: 16, tile: 16 };
                atlasTex = new THREE.CanvasTexture(tileCanvas(0));
                cb();
            });
        };

        ensureAssets(function () {
            if (seq !== loadSeq) return; // 已关闭
            initScene(canvasHost, data);
        });
    }

    function initScene(host, data) {
        var w = host.clientWidth || window.innerWidth;
        var h = host.clientHeight || window.innerHeight - 90;
        renderer = new THREE.WebGLRenderer({ antialias: true });
        renderer.setSize(w, h);
        renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
        host.appendChild(renderer.domElement);

        scene = new THREE.Scene();
        scene.background = new THREE.Color(0x101820);

        var size = data.size;
        var maxDim = Math.max(size.width, size.height, size.length) || 1;
        camera = new THREE.PerspectiveCamera(55, w / h, 0.05, maxDim * 20);
        var dist = maxDim * 2.2;
        camera.position.set(dist * 0.7, dist * 0.55, dist * 0.7);
        camera.lookAt(size.width / 2, size.height / 2, size.length / 2);

        controls = new THREE.OrbitControls(camera, renderer.domElement);
        controls.target.set(size.width / 2, size.height / 2, size.length / 2);
        controls.enableDamping = true;
        controls.dampingFactor = 0.12;
        controls.minDistance = 0.2;
        controls.maxDistance = maxDim * 8;
        controls.update();

        scene.add(new THREE.AmbientLight(0xffffff, 0.72));
        var sun = new THREE.DirectionalLight(0xffffff, 0.85);
        sun.position.set(maxDim, maxDim * 1.4, maxDim * 0.6);
        scene.add(sun);
        var fill = new THREE.DirectionalLight(0x88aaff, 0.25);
        fill.position.set(-maxDim, maxDim * 0.3, -maxDim);
        scene.add(fill);

        // 网格辅助
        var grid = new THREE.GridHelper(Math.max(size.width, size.length), Math.min(40, Math.max(size.width, size.length)), 0x2a5a3a, 0x1a3a28);
        grid.position.y = -0.01;
        scene.add(grid);

        currentGroup = new THREE.Group();
        scene.add(currentGroup);
        build(data, currentGroup);

        animate();
    }

    function animate() {
        if (!renderer || !scene) return;
        requestAnimationFrame(animate);
        if (controls) controls.update();
        renderer.render(scene, camera);
    }

    function close() {
        loadSeq++;
        if (container) {
            if (container._escHandler) document.removeEventListener("keydown", container._escHandler);
            if (container.parentNode) container.parentNode.removeChild(container);
            container = null;
        }
        if (renderer) {
            renderer.dispose();
            renderer = null;
        }
        if (controls) { controls.dispose(); controls = null; }
        scene = null; camera = null; currentGroup = null;
    }

    function esc(s) {
        return String(s == null ? "" : s).replace(/[&<>"']/g, function (m) {
            return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[m];
        });
    }

    window.CGPreview3D = { open: open, close: close };
})();
