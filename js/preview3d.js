/* CrystalGate 3D 建筑预览 v2 (Three.js r128 + 原版贴图)
 * 暴露 window.CGPreview3D = { open(data, assetsBase), close() }
 *
 * data 结构 (来自 /api/parser/preview):
 *   size: {width, height, length}
 *   name_ids: {name: id}
 *   blocks: [x,y,z,id, ...]
 *   total, dropped, filename
 *
 * v2 升级:
 *   - 使用 Minecraft 原版贴图 atlas (26.2)
 *   - 完整形状适配: full/slab/stair/fence/wall/pane/redstone/torch/ladder/
 *     rail/button/lever/sign/banner/pot/candle/chain/lantern/end_rod/
 *     lightning_rod/door/trapdoor/cauldron/hopper/chest/painting/cross/...
 *   - 连接方块邻接逻辑 (栅栏/墙/玻璃板/红石线)
 *   - 创造专属方块开关: 光源方块 / 结构空位 / 屏障方块
 *   - 性能优化: 几何缓存 / 材质缓存 / InstancedMesh / 合并几何
 */
(function () {
    "use strict";

    var ASSETS = "/assets/textures";
    var ATLAS_IMG = ASSETS + "/atlas.png";
    var ATLAS_JSON = ASSETS + "/block_textures.json";

    var container = null, renderer = null, scene = null, camera = null, controls = null;
    var atlasTex = null, atlasMeta = null, blockMeta = null;
    var rootGroup = null, specialGroups = { barrier: null, void: null, light: null };
    var loadSeq = 0, built = false;

    var geoCache = {};          // shape+key -> BufferGeometry
    var matCache = {};          // base+faces+transparent -> MeshLambertMaterial[]

    /* ================= 方块名解析 ================= */
    // 支持 "minecraft:oak_stairs[facing=east,half=bottom]" 与 "minecraft:stone"
    function parseName(raw) {
        raw = String(raw == null ? "" : raw);
        var m = raw.match(/^([^[]+)(?:\[([^\]]*)\])?$/);
        var base = (m ? m[1] : raw).replace(/^minecraft:/, "");
        var states = {};
        if (m && m[2]) {
            m[2].split(",").forEach(function (kv) {
                var p = kv.split("=");
                if (p.length === 2) states[p[0].trim()] = p[1].trim();
            });
        }
        normalizeStates(states);
        return { base: base, states: states, raw: raw };
    }

    // 基岩版/旧版 states 别名 -> Java 语义 (facing/half/type/axis/face/shape)
    var FACING_DIR = { 0: "down", 1: "up", 2: "north", 3: "south", 4: "west", 5: "east" };
    function normalizeStates(states) {
        if (!states) return;
        // 楼梯: 基岩版 weirdo_direction 0=south,1=west,2=north,3=east
        if (states.weirdo_direction != null && states.facing == null) {
            var f = { 0: "south", 1: "west", 2: "north", 3: "east" }[String(states.weirdo_direction)];
            if (f) states.facing = f;
        }
        // upside_down_bit -> half (true=top)
        if (states.upside_down_bit != null && states.half == null) {
            states.half = (states.upside_down_bit === "true" || states.upside_down_bit === true) ? "top" : "bottom";
        }
        // 半砖: top_slot_bit -> type (true=top)
        if (states.top_slot_bit != null && states.type == null) {
            states.type = (states.top_slot_bit === "true" || states.top_slot_bit === true) ? "top" : "bottom";
        }
        // 柱体: pillar_axis -> axis
        if (states.pillar_axis != null && states.axis == null) {
            states.axis = String(states.pillar_axis);
        }
        // 火把: torch_facing_direction -> facing (top/unknown 保持直立)
        if (states.torch_facing_direction != null && states.facing == null) {
            var tf = String(states.torch_facing_direction);
            if (tf === "west" || tf === "east" || tf === "north" || tf === "south") states.facing = tf;
        }
        // 按钮/拉杆/活板门/门: facing_direction -> face/facing
        if (states.facing_direction != null) {
            var dir = FACING_DIR[String(states.facing_direction)] || "";
            if (states.face == null && (dir === "down" || dir === "up")) {
                states.face = (dir === "down") ? "ceiling" : "floor";
            } else if (states.face == null && dir) {
                states.face = "wall";
            }
            if (states.facing == null && (dir === "north" || dir === "south" || dir === "west" || dir === "east")) {
                states.facing = dir;
            }
        }
        // 铁轨: rail_direction 0=N-S,1=E-W,2=SE-NW,3=SW-NE -> shape
        if (states.rail_direction != null && states.shape == null) {
            var rd = String(states.rail_direction);
            states.shape = (rd === "1") ? "east_west" : "north_south";
        }
    }

    /* ================= 元数据查询 ================= */
    function metaOf(parsed) {
        if (!blockMeta) return null;
        var b = parsed.base;
        var hit = blockMeta["minecraft:" + b] || blockMeta[b] || blockMeta["minecraft:" + b.split("[")[0]];
        // light_block 是新版方块名, 元数据以旧名 light 收录, 补一个兜底
        if (!hit && b === "light_block" && blockMeta["minecraft:light"]) {
            hit = blockMeta["minecraft:light"];
        }
        return hit || null;
    }

    function shapeOf(parsed) {
        var m = metaOf(parsed);
        if (m && m.shape) return m.shape;
        return "full";
    }

    function groupOf(parsed) {
        var m = metaOf(parsed);
        return (m && m.group) || "";
    }

    /* ================= atlas 工具 ================= */
    function tileCanvas(index) {
        var cols = (atlasMeta && atlasMeta.cols) || 32;
        var ts = (atlasMeta && atlasMeta.tile) || 32;
        var idx = Number(index);
        if (!isFinite(idx) || idx < 0) idx = 0;
        var c = document.createElement("canvas");
        c.width = ts; c.height = ts;
        var ctx = c.getContext("2d");
        var r = Math.floor(idx / cols), col = idx % cols;
        ctx.imageSmoothingEnabled = false;
        ctx.drawImage(atlasTex.image, col * ts, r * ts, ts, ts, 0, 0, ts, ts);
        return c;
    }

    function texIndex(name) {
        if (!atlasMeta || !atlasMeta.textures) return 0;
        var i = atlasMeta.textures[name];
        return (isFinite(Number(i)) ? Number(i) : 0);
    }

    /* ================= 材质 (按方块 6 面) ================= */
    // faces: [px,nx,py,ny,pz,nz] 纹理名数组
    function materialFor(parsed, transparent) {
        var m = metaOf(parsed);
        var faces = (m && m.faces) || ["stone", "stone", "stone", "stone", "stone", "stone"];
        var key = parsed.base + "|" + faces.join(",") + "|" + (transparent ? 1 : 0);
        if (matCache[key]) return matCache[key];
        var mats = faces.map(function (tn) {
            var tex = new THREE.CanvasTexture(tileCanvas(texIndex(tn)));
            tex.magFilter = THREE.NearestFilter;
            tex.minFilter = THREE.NearestFilter;
            tex.generateMipmaps = false;
            if (transparent) {
                return new THREE.MeshLambertMaterial({ map: tex, transparent: true, opacity: 0.82, side: THREE.DoubleSide, depthWrite: false });
            }
            return new THREE.MeshLambertMaterial({ map: tex, side: THREE.DoubleSide });
        });
        matCache[key] = mats;
        return mats;
    }

    // 单材质版本 (复杂形状: 全部部件使用 top 纹理)
    function singleMaterialFor(parsed, transparent, useTop) {
        var m = metaOf(parsed);
        var faces = (m && m.faces) || ["stone", "stone", "stone", "stone", "stone", "stone"];
        var tn = useTop ? faces[2] : faces[0];
        var key = "S|" + tn + "|" + (transparent ? 1 : 0);
        if (matCache[key]) return matCache[key];
        var tex = new THREE.CanvasTexture(tileCanvas(texIndex(tn)));
        tex.magFilter = THREE.NearestFilter;
        tex.minFilter = THREE.NearestFilter;
        tex.generateMipmaps = false;
        var mat = transparent
            ? new THREE.MeshLambertMaterial({ map: tex, transparent: true, opacity: 0.82, side: THREE.DoubleSide, depthWrite: false })
            : new THREE.MeshLambertMaterial({ map: tex, side: THREE.DoubleSide });
        matCache[key] = mat;
        return mat;
    }

    /* ================= 几何生成 =================
     * 所有几何均位于单位方块空间: x/z ∈ [-0.5,0.5], y ∈ [0,1]
     * 返回 BufferGeometry (带 position/uv/normal) 或 THREE.Group
     */
    function boxGeo(w, h, d, tx, ty, tz) {
        var g = new THREE.BoxGeometry(w, h, d);
        g.translate(tx || 0, ty || 0, tz || 0);
        return g;
    }

    function mergeGeos(geos) {
        if (geos.length === 1) return geos[0];
        var all = [];
        geos.forEach(function (g) { all.push(g); });
        // 手动合并 position/uv/normal
        var totalVerts = 0;
        all.forEach(function (g) { totalVerts += g.attributes.position.count; });
        var pos = new Float32Array(totalVerts * 3);
        var uv = new Float32Array(totalVerts * 2);
        var nor = new Float32Array(totalVerts * 3);
        var off = 0;
        all.forEach(function (g) {
            var p = g.attributes.position.array, u = g.attributes.uv.array, n = g.attributes.normal.array;
            var cnt = g.attributes.position.count;
            pos.set(p, off * 3);
            uv.set(u, off * 2);
            nor.set(n, off * 3);
            off += cnt;
        });
        var out = new THREE.BufferGeometry();
        out.setAttribute("position", new THREE.BufferAttribute(pos, 3));
        out.setAttribute("uv", new THREE.BufferAttribute(uv, 2));
        out.setAttribute("normal", new THREE.BufferAttribute(nor, 3));
        return out;
    }

    function geoFull() { return boxGeo(1, 1, 1, 0, 0.5, 0); }

    function geoPillar(opts) {
        // 原木/柱体: 默认竖放(y轴), 按 axis 横放旋转
        var axis = opts.axis || "y";
        var g = geoFull();
        if (axis === "x") g.rotateZ(Math.PI / 2);
        else if (axis === "z") g.rotateX(Math.PI / 2);
        return g;
    }

    function geoSlab(opts) {
        var half = opts.half || "bottom";
        if (half === "double") return geoFull();
        var y = (half === "top") ? 0.75 : 0.25;
        return boxGeo(1, 0.5, 1, 0, y, 0);
    }

    function geoStair(opts) {
        // 楼梯: 主台阶 + 竖板, 支持 facing(4向) + half(top/bottom)
        var facing = opts.facing || "north";
        var top = (opts.half === "top");
        var main = boxGeo(1, 0.5, 0.5, 0, 0.25, -0.25);
        var riser = boxGeo(1, 0.5, 0.5, 0, 0.75, 0.25);
        var g = mergeGeos([main, riser]);
        if (top) {
            g.translate(0, 0.5, 0);
            g.rotateY(Math.PI);
        }
        // facing: north(+z 方向低), south, east, west
        var rot = { north: 0, south: Math.PI, east: -Math.PI / 2, west: Math.PI / 2 }[facing] || 0;
        if (rot) g.rotateY(rot);
        return g;
    }

    function geoFence(opts) {
        // 栅栏: 4 立柱 + 上下横杆, mask 4位: +x,-x,+z,-z 有连接
        var mask = opts.mask || 0;
        var geos = [];
        var post = boxGeo(0.18, 1, 0.18, 0, 0.5, 0);
        geos.push(post);
        // 横杆: 沿 x 或 z
        var railY = [0.72, 0.38];
        railY.forEach(function (ry) {
            if (mask & 1) geos.push(boxGeo(0.82, 0.11, 0.11, 0.25, ry, 0));   // +x
            if (mask & 2) geos.push(boxGeo(0.82, 0.11, 0.11, -0.25, ry, 0));  // -x
            if (mask & 4) geos.push(boxGeo(0.11, 0.11, 0.82, 0, ry, 0.25));   // +z
            if (mask & 8) geos.push(boxGeo(0.11, 0.11, 0.82, 0, ry, -0.25));  // -z
        });
        // 无连接时仅立柱(已有)
        return mergeGeos(geos);
    }

    function geoWall(opts) {
        // 墙: 粗立柱 + 矮横杆, 与栅栏类似但更粗
        var mask = opts.mask || 0;
        var geos = [];
        var post = boxGeo(0.3, 1, 0.3, 0, 0.5, 0);
        geos.push(post);
        var railY = [0.72, 0.36];
        railY.forEach(function (ry) {
            if (mask & 1) geos.push(boxGeo(0.7, 0.16, 0.16, 0.25, ry, 0));
            if (mask & 2) geos.push(boxGeo(0.7, 0.16, 0.16, -0.25, ry, 0));
            if (mask & 4) geos.push(boxGeo(0.16, 0.16, 0.7, 0, ry, 0.25));
            if (mask & 8) geos.push(boxGeo(0.16, 0.16, 0.7, 0, ry, -0.25));
        });
        return mergeGeos(geos);
    }

    function geoPane(opts) {
        // 玻璃板/铁栏杆: 中心立柱 + 四向薄横杆
        var mask = opts.mask || 0;
        var geos = [];
        geos.push(boxGeo(0.12, 1, 0.12, 0, 0.5, 0));
        var ry = 0.55;
        if (mask & 1) geos.push(boxGeo(0.88, 0.12, 0.12, 0.25, ry, 0));
        if (mask & 2) geos.push(boxGeo(0.88, 0.12, 0.12, -0.25, ry, 0));
        if (mask & 4) geos.push(boxGeo(0.12, 0.12, 0.88, 0, ry, 0.25));
        if (mask & 8) geos.push(boxGeo(0.12, 0.12, 0.88, 0, ry, -0.25));
        // 中心玻璃薄板 (横向延伸)
        if (mask & 1) geos.push(boxGeo(0.9, 0.92, 0.1, 0.2, 0.46, 0));
        if (mask & 2) geos.push(boxGeo(0.9, 0.92, 0.1, -0.2, 0.46, 0));
        if (mask & 4) geos.push(boxGeo(0.1, 0.92, 0.9, 0, 0.46, 0.2));
        if (mask & 8) geos.push(boxGeo(0.1, 0.92, 0.9, 0, 0.46, -0.2));
        return mergeGeos(geos);
    }

    function geoRedstone(opts) {
        // 红石线: 底座 + 四向连线
        var mask = opts.mask || 0;
        var geos = [];
        geos.push(boxGeo(0.875, 0.0625, 0.875, 0, 0.03125, 0));
        var ly = 0.078;
        var lw = 0.09;
        if (mask & 1) geos.push(boxGeo(0.5, 0.03125, lw, 0.25, ly, 0));
        if (mask & 2) geos.push(boxGeo(0.5, 0.03125, lw, -0.25, ly, 0));
        if (mask & 4) geos.push(boxGeo(lw, 0.03125, 0.5, 0, ly, 0.25));
        if (mask & 8) geos.push(boxGeo(lw, 0.03125, 0.5, 0, ly, -0.25));
        return mergeGeos(geos);
    }

    function geoTorch(opts) {
        // 火把: 细柱 + 顶部火头
        var geos = [];
        geos.push(new THREE.CylinderGeometry(0.07, 0.09, 0.62, 6).translate(0, 0.34, 0));
        geos.push(boxGeo(0.2, 0.14, 0.2, 0, 0.78, 0));
        return mergeGeos(geos);
    }

    function geoCross(opts) {
        var h = opts.height || 0.8;
        var g = new THREE.BufferGeometry();
        var p = [
            -0.5, 0, 0, 0.5, 0, 0, 0.5, h, 0, -0.5, 0, 0, 0.5, h, 0, -0.5, h, 0,
            0, 0, -0.5, 0, 0, 0.5, 0, h, 0.5, 0, 0, -0.5, 0, h, 0.5, 0, h, -0.5,
        ];
        var uv = new Float32Array([
            0, 1, 1, 1, 1, 0, 0, 1, 1, 0, 0, 0,
            0, 1, 1, 1, 1, 0, 0, 1, 1, 0, 0, 0,
        ]);
        g.setAttribute("position", new THREE.BufferAttribute(new Float32Array(p), 3));
        g.setAttribute("uv", new THREE.BufferAttribute(uv, 2));
        g.computeVertexNormals();
        return g;
    }

    function geoFlat() { return boxGeo(1, 0.0625, 1, 0, 0.03125, 0); }
    function geoSnow() { return boxGeo(1, 0.125, 1, 0, 0.0625, 0); }
    function geoThin() { return boxGeo(0.16, 1, 0.16, 0, 0.5, 0); }

    function geoLadder() { return boxGeo(0.14, 1, 1, 0, 0.5, 0); }

    function geoRail(opts) {
        var shape = opts.railShape || "north_south";
        if (shape === "east_west") return boxGeo(1, 0.0625, 0.25, 0, 0.03125, 0);
        if (shape === "ascending_east" || shape === "ascending_west") return boxGeo(1, 0.0625, 0.25, 0, 0.0625, 0);
        if (shape === "ascending_north" || shape === "ascending_south") return boxGeo(0.25, 0.0625, 1, 0, 0.0625, 0);
        return boxGeo(0.25, 0.0625, 1, 0, 0.03125, 0); // north_south 默认
    }

    function geoButton(opts) {
        var face = opts.face || "floor";
        if (face === "ceiling") return boxGeo(0.25, 0.25, 0.25, 0, 0.875, 0);
        if (face === "wall" || face === "wall_side") return boxGeo(0.25, 0.25, 0.25, 0, 0.5, -0.4);
        return boxGeo(0.25, 0.25, 0.25, 0, 0.125, 0); // floor
    }

    function geoLever(opts) {
        var face = opts.face || "floor";
        var geos = [];
        if (face === "ceiling") {
            geos.push(boxGeo(0.25, 0.25, 0.25, 0, 0.875, 0));
            geos.push(boxGeo(0.08, 0.5, 0.08, 0, 0.55, 0).rotateZ(Math.PI / 5));
        } else {
            geos.push(boxGeo(0.25, 0.25, 0.25, 0, 0.125, 0));
            geos.push(boxGeo(0.08, 0.5, 0.08, 0, 0.45, 0).rotateZ(-Math.PI / 5));
        }
        return mergeGeos(geos);
    }

    function geoSign() { return boxGeo(0.14, 0.625, 0.5, 0, 0.35, 0); }
    function geoBanner() { return boxGeo(0.1, 1, 0.08, 0, 0.5, 0); }
    function geoPot() { return new THREE.CylinderGeometry(0.28, 0.36, 0.4, 8).translate(0, 0.2, 0); }
    function geoChain() { return new THREE.CylinderGeometry(0.07, 0.07, 1, 6).translate(0, 0.5, 0); }
    function geoCandle() {
        var geos = [];
        geos.push(new THREE.CylinderGeometry(0.09, 0.1, 0.4, 6).translate(0, 0.2, 0));
        geos.push(new THREE.CylinderGeometry(0.04, 0.05, 0.14, 5).translate(0, 0.45, 0));
        return mergeGeos(geos);
    }
    function geoLantern() {
        var geos = [];
        geos.push(boxGeo(0.06, 0.14, 0.06, 0, 0.9, 0));
        geos.push(boxGeo(0.42, 0.42, 0.42, 0, 0.55, 0));
        geos.push(boxGeo(0.08, 0.06, 0.08, 0, 0.36, 0));
        return mergeGeos(geos);
    }
    function geoEndRod() {
        var geos = [];
        geos.push(new THREE.CylinderGeometry(0.08, 0.08, 0.9, 6).translate(0, 0.45, 0));
        geos.push(boxGeo(0.2, 0.1, 0.2, 0, 0.96, 0));
        return mergeGeos(geos);
    }
    function geoLightningRod() {
        var geos = [];
        geos.push(new THREE.CylinderGeometry(0.08, 0.08, 0.92, 6).translate(0, 0.46, 0));
        geos.push(new THREE.ConeGeometry(0.12, 0.14, 6).translate(0, 0.98, 0));
        return mergeGeos(geos);
    }
    function geoDoor(opts) {
        // 门: 单块薄板 (用 top 面纹理)
        return boxGeo(0.94, 1, 0.12, 0, 0.5, 0);
    }
    function geoTrapdoor(opts) {
        var half = opts.half || "bottom";
        var y = (half === "top") ? 0.875 : 0.0625;
        return boxGeo(1, 0.125, 1, 0, y, 0);
    }
    function geoCauldron() { return boxGeo(1, 0.5, 1, 0, 0.25, 0); }
    function geoHopper() { return boxGeo(1, 0.5, 1, 0, 0.25, 0); }
    function geoChest() {
        var geos = [];
        geos.push(boxGeo(0.94, 0.62, 0.94, 0, 0.31, 0));
        geos.push(boxGeo(0.94, 0.24, 0.94, 0, 0.72, 0));
        return mergeGeos(geos);
    }
    function geoPainting() { return boxGeo(1, 1, 0.08, 0, 0.5, 0); }
    function geoPortal() { return boxGeo(0.5, 2, 0.5, 0, 0.75, 0); }
    function geoBarrier() {
        // 屏障: 半透明线框盒
        var box = new THREE.BoxGeometry(1, 1, 1);
        box.translate(0, 0.5, 0);
        var edges = new THREE.EdgesGeometry(box);
        var line = new THREE.BufferGeometry();
        var p = edges.attributes.position.array;
        var pos = new Float32Array(p.length);
        pos.set(p);
        line.setAttribute("position", new THREE.BufferAttribute(pos, 3));
        // 加一个半透明面盒
        return mergeGeos([box, line]);
    }
    function geoVoid() {
        var box = new THREE.BoxGeometry(0.6, 0.6, 0.6);
        box.translate(0, 0.3, 0);
        return box;
    }
    function geoLight() {
        return new THREE.SphereGeometry(0.34, 10, 10).translate(0, 0.5, 0);
    }
    function geoSpawner() { return boxGeo(1, 1, 1, 0, 0.5, 0); }
    function geoFire() { return geoCross({ height: 0.7 }); }

    // 形状 -> 几何函数 (geoCache 缓存)
    function getGeo(shape, opts) {
        var key = shape + "|" + (opts ? JSON.stringify(opts) : "");
        if (geoCache[key]) return geoCache[key];
        var g;
        switch (shape) {
            case "full": g = geoFull(); break;
            case "pillar": g = geoPillar(opts || {}); break;
            case "slab": g = geoSlab(opts || {}); break;
            case "stair": g = geoStair(opts || {}); break;
            case "fence": g = geoFence(opts || {}); break;
            case "wall": g = geoWall(opts || {}); break;
            case "pane": g = geoPane(opts || {}); break;
            case "redstone": g = geoRedstone(opts || {}); break;
            case "torch": g = geoTorch(opts || {}); break;
            case "cross": g = geoCross(opts || {}); break;
            case "flat": g = geoFlat(); break;
            case "snow": g = geoSnow(); break;
            case "thin": g = geoThin(); break;
            case "ladder": g = geoLadder(); break;
            case "rail": g = geoRail(opts || {}); break;
            case "button": g = geoButton(opts || {}); break;
            case "lever": g = geoLever(opts || {}); break;
            case "sign": g = geoSign(); break;
            case "banner": g = geoBanner(); break;
            case "pot": g = geoPot(); break;
            case "chain": g = geoChain(); break;
            case "candle": g = geoCandle(); break;
            case "lantern": g = geoLantern(); break;
            case "end_rod": g = geoEndRod(); break;
            case "lightning_rod": g = geoLightningRod(); break;
            case "door": g = geoDoor(opts || {}); break;
            case "trapdoor": g = geoTrapdoor(opts || {}); break;
            case "cauldron": g = geoCauldron(); break;
            case "hopper": g = geoHopper(); break;
            case "chest": g = geoChest(); break;
            case "painting": g = geoPainting(); break;
            case "portal": g = geoPortal(); break;
            case "barrier": g = geoBarrier(); break;
            case "void": g = geoVoid(); break;
            case "light": g = geoLight(); break;
            case "spawner": g = geoSpawner(); break;
            case "fire": g = geoFire(); break;
            default: g = geoFull();
        }
        geoCache[key] = g;
        return g;
    }

    /* ================= 邻接判定 ================= */
    var CONN_FENCE = { fence: 1, fence_gate: 1, wall: 1 };
    var CONN_WALL = { fence: 1, fence_gate: 1, wall: 1 };
    var CONN_PANE = { pane: 1, glass: 1, iron_bars: 1 };
    var CONN_REDSTONE = { redstone: 1, repeater: 1, comparator: 1, redstone_torch: 1, lever: 1, button: 1 };

    // 预构建 baseSet: "x,y,z" -> base (只记录需要连接判断的 base 与普通 base)
    var posBase = null;

    function baseAt(x, y, z) {
        if (!posBase) return null;
        return posBase[x + "," + y + "," + z] || null;
    }

    function connMask(x, y, z, connMap) {
        var m = 0;
        if (connMap[baseAt(x + 1, y, z)] || 0) m |= 1;
        if (connMap[baseAt(x - 1, y, z)] || 0) m |= 2;
        if (connMap[baseAt(x, y, z + 1)] || 0) m |= 4;
        if (connMap[baseAt(x, y, z - 1)] || 0) m |= 8;
        return m;
    }

    /* ================= 构建场景 ================= */
    function build(data, root) {
        var size = data.size;
        var w = size.width, h = size.height, l = size.length;
        var names = Object.keys(data.name_ids);
        var blocks = data.blocks;
        var n = blocks.length / 4;

        // 收集: 每个方块 -> {parsed, x, y, z}
        var items = [];
        posBase = {};
        for (var i = 0; i < n; i++) {
            var x = blocks[i * 4], y = blocks[i * 4 + 1], z = blocks[i * 4 + 2];
            var id = blocks[i * 4 + 3];
            var rawName = names[id];
            var parsed = parseName(rawName);
            var base = parsed.base;
            if (shapeOf(parsed) === "air") continue;
            items.push({ parsed: parsed, x: x, y: y, z: z });
            posBase[x + "," + y + "," + z] = base;
        }
        var total = items.length;

        var half = { x: w / 2, y: h / 2, z: l / 2 };
        var halfW = w / 2, halfH = h / 2, halfL = l / 2;

        // 按 (base, shape, mask, opts) 分组
        var groups = {};
        var specialItems = { barrier: [], void: [], light: [] };

        items.forEach(function (it) {
            var p = it.parsed, base = p.base;
            var shape = shapeOf(p);
            var grp = groupOf(p);
            if (grp === "barrier" || grp === "void" || grp === "light") {
                specialItems[grp].push(it);
                return;
            }
            var opts = {};
            // 从 states 提取形状参数
            if (shape === "pillar") opts.axis = p.states.axis || "y";
            if (shape === "slab") opts.half = p.states.type || "bottom";
            if (shape === "stair") {
                opts.facing = p.states.facing || "north";
                opts.half = p.states.half || "bottom";
            }
            if (shape === "fence") opts.mask = connMask(it.x, it.y, it.z, CONN_FENCE);
            if (shape === "wall") opts.mask = connMask(it.x, it.y, it.z, CONN_WALL);
            if (shape === "pane") opts.mask = connMask(it.x, it.y, it.z, CONN_PANE);
            if (shape === "redstone") opts.mask = connMask(it.x, it.y, it.z, CONN_REDSTONE);
            if (shape === "rail") opts.railShape = p.states.shape || "north_south";
            if (shape === "button") opts.face = p.states.face || "floor";
            if (shape === "lever") opts.face = p.states.face || "floor";
            if (shape === "trapdoor") opts.half = p.states.half || "bottom";
            var key = base + "|" + shape + "|" + JSON.stringify(opts);
            if (!groups[key]) groups[key] = { parsed: p, shape: shape, opts: opts, pts: [] };
            groups[key].pts.push([it.x, it.y, it.z]);
        });

        var keys = Object.keys(groups);

        // 构建普通方块 (InstancedMesh)
        keys.forEach(function (key) {
            var grp = groups[key];
            var pts = grp.pts;
            var shape = grp.shape;
            var parsed = grp.parsed;
            var transparent = (metaOf(parsed) && metaOf(parsed).transparent) || false;

            var geo = getGeo(shape, grp.opts);
            var mats;

            // 复杂形状 (多部件) 用单材质; 简单盒体用 6 面材质
            var complexShapes = { fence: 1, wall: 1, pane: 1, redstone: 1, torch: 1, cross: 1,
                lever: 1, lantern: 1, end_rod: 1, lightning_rod: 1, candle: 1, chest: 1,
                barrier: 1, fire: 1, chain: 1 };
            if (complexShapes[shape]) {
                var mat = singleMaterialFor(parsed, transparent, shape === "redstone" || shape === "torch" || shape === "candle" || shape === "lantern" || shape === "end_rod" || shape === "lightning_rod");
                mats = mat;
            } else {
                mats = materialFor(parsed, transparent);
            }

            var im = new THREE.InstancedMesh(geo, mats, pts.length);
            var mat4 = new THREE.Matrix4();
            var pos = new THREE.Vector3(), quat = new THREE.Quaternion(), scl = new THREE.Vector3(1, 1, 1);
            for (var k = 0; k < pts.length; k++) {
                pos.set(pts[k][0] - halfW, pts[k][1], pts[k][2] - halfL);
                mat4.compose(pos, quat, scl);
                im.setMatrixAt(k, mat4);
            }
            im.instanceMatrix.needsUpdate = true;
            im.frustumCulled = false;
            root.add(im);
        });

        // 特殊方块组 (默认隐藏)
        function buildSpecial(items, groupName) {
            var g = new THREE.Group();
            items.forEach(function (it) {
                var p = it.parsed;
                var shape = shapeOf(p);
                var geo = getGeo(shape, {});
                var transparent = true;
                var mat;
                if (shape === "barrier") {
                    var m0 = new THREE.MeshLambertMaterial({ color: 0xff4444, transparent: true, opacity: 0.28, side: THREE.DoubleSide, depthWrite: false });
                    var m1 = new THREE.LineBasicMaterial({ color: 0xff2222, transparent: true, opacity: 0.9 });
                    // geo 是合并的 (面+线), 用一个半透明面材质 + 线材质无法区分; 拆开构建
                    var box = new THREE.BoxGeometry(1, 1, 1); box.translate(0, 0.5, 0);
                    var mesh = new THREE.Mesh(box, m0);
                    mesh.position.set(it.x - halfW, it.y, it.z - halfL);
                    var edges = new THREE.EdgesGeometry(box);
                    var line = new THREE.LineSegments(edges, m1);
                    line.position.copy(mesh.position);
                    g.add(mesh); g.add(line);
                    return;
                }
                if (shape === "void") {
                    mat = new THREE.MeshBasicMaterial({ color: 0x66ffcc, wireframe: true, transparent: true, opacity: 0.5 });
                } else { // light
                    mat = new THREE.MeshBasicMaterial({ color: 0xffdd66, transparent: true, opacity: 0.55, depthWrite: false });
                }
                var mesh = new THREE.Mesh(geo, mat);
                mesh.position.set(it.x - halfW, it.y, it.z - halfL);
                g.add(mesh);
            });
            root.add(g);
            return g;
        }

        specialGroups.barrier = buildSpecial(specialItems.barrier, "barrier");
        specialGroups.void = buildSpecial(specialItems.void, "void");
        specialGroups.light = buildSpecial(specialItems.light, "light");

        return total;
    }

    /* ================= UI ================= */
    function esc(s) {
        return String(s == null ? "" : s).replace(/[&<>"']/g, function (m) {
            return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[m];
        });
    }

    function buildUI(data, total) {
        // 底部控制条
        var bar = document.createElement("div");
        bar.id = "cg-preview3d-bar";
        bar.style.cssText = "flex:0 0 auto;display:flex;align-items:center;flex-wrap:wrap;gap:10px 18px;padding:10px 18px;background:rgba(10,16,22,0.92);border-top:1px solid rgba(140,220,170,0.18);font-size:13px;color:#b8d8c0;";

        function makeCheck(id, label, cb) {
            var lab = document.createElement("label");
            lab.style.cssText = "display:inline-flex;align-items:center;gap:6px;cursor:pointer;user-select:none;color:#cfe8d6;";
            var chk = document.createElement("input");
            chk.type = "checkbox";
            chk.id = id;
            chk.style.cssText = "accent-color:#7ed99a;width:15px;height:15px;cursor:pointer;";
            chk.addEventListener("change", cb);
            var span = document.createElement("span");
            span.textContent = label;
            lab.appendChild(chk); lab.appendChild(span);
            bar.appendChild(lab);
        }

        makeCheck("cg-pv3d-light", "显示光源方块", function (e) {
            if (specialGroups.light) specialGroups.light.visible = e.target.checked;
        });
        makeCheck("cg-pv3d-void", "显示结构空位", function (e) {
            if (specialGroups.void) specialGroups.void.visible = e.target.checked;
        });
        makeCheck("cg-pv3d-barrier", "显示屏障方块", function (e) {
            if (specialGroups.barrier) specialGroups.barrier.visible = e.target.checked;
        });

        var sep = document.createElement("span");
        sep.style.cssText = "opacity:0.35;";
        sep.textContent = "|";
        bar.appendChild(sep);

        var btnReset = document.createElement("button");
        btnReset.textContent = "重置视角";
        btnReset.style.cssText = "background:rgba(120,220,160,0.12);border:1px solid rgba(120,220,160,0.35);color:#a8e8bc;padding:3px 12px;cursor:pointer;border-radius:4px;font-size:12px;";
        btnReset.addEventListener("click", resetCamera);
        bar.appendChild(btnReset);

        var btnAuto = document.createElement("button");
        btnAuto.id = "cg-pv3d-auto";
        btnAuto.textContent = "自动旋转: 关";
        btnAuto.style.cssText = btnReset.style.cssText;
        btnAuto.addEventListener("click", function () {
            if (!controls) return;
            controls.autoRotate = !controls.autoRotate;
            btnAuto.textContent = "自动旋转: " + (controls.autoRotate ? "开" : "关");
        });
        bar.appendChild(btnAuto);

        var info = document.createElement("span");
        info.style.cssText = "margin-left:auto;color:#7fa890;font-size:12px;";
        info.textContent = (total || 0) + " 方块 · " + Object.keys(data.name_ids).length + " 种 · " +
            data.size.width + "×" + data.size.height + "×" + data.size.length + " · 拖动旋转 / 滚轮缩放 / 右键平移";
        bar.appendChild(info);

        return bar;
    }

    /* ================= 打开/关闭 ================= */
    function open(data) {
        close();
        var seq = ++loadSeq;

        container = document.createElement("div");
        container.id = "cg-preview3d";
        container.style.cssText = "position:fixed;inset:0;z-index:9999;background:linear-gradient(180deg,#0b1218 0%,#101a24 100%);display:flex;flex-direction:column;font-family:'Segoe UI',system-ui,sans-serif;color:#cfe8d0;";
        var header = document.createElement("div");
        header.style.cssText = "flex:0 0 auto;display:flex;align-items:center;justify-content:space-between;gap:12px;padding:12px 18px;border-bottom:1px solid rgba(140,220,170,0.18);background:rgba(8,12,16,0.6);";
        header.innerHTML = '<div style="font-size:15px;font-weight:600;color:#8aff9e;">3D 预览: ' + esc(data.filename || "") + '</div>' +
            '<button id="cg-preview3d-close" style="background:rgba(200,60,60,0.16);border:1px solid rgba(255,120,120,0.4);color:#ffb0b0;padding:5px 16px;cursor:pointer;border-radius:5px;font-size:13px;">关闭 [Esc]</button>';
        container.appendChild(header);

        var canvasHost = document.createElement("div");
        canvasHost.id = "cg-preview3d-canvas";
        canvasHost.style.cssText = "flex:1;position:relative;min-height:0;";
        container.appendChild(canvasHost);

        var loading = document.createElement("div");
        loading.id = "cg-preview3d-loading";
        loading.style.cssText = "position:absolute;inset:0;display:flex;align-items:center;justify-content:center;font-size:14px;color:#8fb8a0;z-index:2;";
        loading.textContent = "正在加载原版贴图并构建 3D 场景…";
        canvasHost.appendChild(loading);

        var bar = buildUI(data, null);
        container.appendChild(bar);
        document.body.appendChild(container);

        document.getElementById("cg-preview3d-close").addEventListener("click", close);
        var escHandler = function (e) { if (e.key === "Escape") close(); };
        document.addEventListener("keydown", escHandler);
        container._escHandler = escHandler;

        // 加载资源
        ensureAssets(function () {
            if (seq !== loadSeq) return;
            var total = initScene(canvasHost, data);
            var info = bar.querySelector("span:last-child");
            if (info) {
                info.textContent = (total || 0) + " 方块 · " + Object.keys(data.name_ids).length + " 种 · " +
                    data.size.width + "×" + data.size.height + "×" + data.size.length + " · 拖动旋转 / 滚轮缩放 / 右键平移";
            }
            if (loading && loading.parentNode) loading.parentNode.removeChild(loading);
        });
    }

    function ensureAssets(cb) {
        if (atlasTex && atlasMeta && blockMeta) { cb(); return; }
        fetch(ATLAS_JSON).then(function (r) { return r.json(); }).then(function (meta) {
            atlasMeta = meta;
            blockMeta = meta.blocks;
            var loader = new THREE.TextureLoader();
            atlasTex = loader.load(ATLAS_IMG, function () { cb(); });
        }).catch(function () {
            // 兜底: 无贴图时纯色
            blockMeta = {};
            atlasMeta = { tile: 32, cols: 32, textures: {} };
            var c = document.createElement("canvas"); c.width = 32; c.height = 32;
            var ctx = c.getContext("2d"); ctx.fillStyle = "#8a8a8a"; ctx.fillRect(0, 0, 32, 32);
            atlasTex = new THREE.CanvasTexture(c);
            cb();
        });
    }

    function initScene(host, data) {
        var w = host.clientWidth || window.innerWidth;
        var h = host.clientHeight || window.innerHeight - 100;
        renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: "high-performance" });
        renderer.setSize(w, h);
        renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.75));
        host.appendChild(renderer.domElement);

        scene = new THREE.Scene();
        scene.background = new THREE.Color(0x0d151d);

        var size = data.size;
        var maxDim = Math.max(size.width, size.height, size.length) || 1;
        camera = new THREE.PerspectiveCamera(52, w / h, 0.05, maxDim * 40);
        var dist = maxDim * 2.1 + 2;
        camera.position.set(dist * 0.72, dist * 0.6, dist * 0.72);
        camera.lookAt(size.width / 2, size.height / 2, size.length / 2);

        controls = new THREE.OrbitControls(camera, renderer.domElement);
        controls.target.set(size.width / 2, size.height / 2, size.length / 2);
        controls.enableDamping = true;
        controls.dampingFactor = 0.1;
        controls.minDistance = 0.5;
        controls.maxDistance = maxDim * 10 + 10;
        controls.maxPolarAngle = Math.PI * 0.98;
        controls.autoRotateSpeed = 2.0;
        controls.update();

        scene.add(new THREE.AmbientLight(0xffffff, 0.62));
        var sun = new THREE.DirectionalLight(0xffffff, 0.95);
        sun.position.set(maxDim * 0.8, maxDim * 1.4, maxDim * 0.6);
        scene.add(sun);
        var fill = new THREE.DirectionalLight(0x88aaff, 0.3);
        fill.position.set(-maxDim, maxDim * 0.3, -maxDim);
        scene.add(fill);

        // 网格辅助
        var gridSize = Math.max(size.width, size.length);
        var grid = new THREE.GridHelper(gridSize, Math.min(48, gridSize), 0x2a6a48, 0x183a2a);
        grid.position.y = -0.02;
        scene.add(grid);

        rootGroup = new THREE.Group();
        scene.add(rootGroup);
        var total = build(data, rootGroup);

        // 相框/边缘 (可选)
        animate();
        return total;
    }

    var _camTarget = null;
    function resetCamera() {
        if (!camera || !controls) return;
        var size = _camTarget || { width: 10, height: 10, length: 10 };
        var maxDim = Math.max(size.width, size.height, size.length) || 1;
        var dist = maxDim * 2.1 + 2;
        camera.position.set(dist * 0.72, dist * 0.6, dist * 0.72);
        controls.target.set(size.width / 2, size.height / 2, size.length / 2);
        controls.update();
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
        if (renderer) { renderer.dispose(); renderer = null; }
        if (controls) { controls.dispose(); controls = null; }
        scene = null; camera = null; rootGroup = null; posBase = null;
        specialGroups = { barrier: null, void: null, light: null };
    }

    window.CGPreview3D = { open: open, close: close };
})();
