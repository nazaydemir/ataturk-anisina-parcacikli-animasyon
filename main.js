// 10 Kasım · fotoğrafı onbinlerce karakter parçacığına bölüp WebGL2 ile çizer.
// Tüm hareket GPU'da (vertex shader) hesaplanır: CPU'da parçacık başına iş yoktur.
(() => {
    const AYAR = {
        PARCACIK: 60000,           // fotoğrafın bölüneceği yaklaşık hücre sayısı (WebGL ile 100000+ de olur)
        KARAKTERLER: ".:-=+*#%@",  // koyudan açığa karakter dizisi
        ESIK: 0.01,                // bundan karanlık hücreler çizilmez
        PARLAKLIK: 1.4,            // genel parlaklık çarpanı
        GAMA: 0.85,                // 1'den küçük = gölgeler açılır
        KARAKTER_BOYUTU: 1.25,     // karakterin hücreye oranı
        TARAMA_SURESI: 2.4,        // soldan sağa belirme süresi (sn)
        BASLANGIC_BEKLEME: 0.6,    // ilk bekleme (sn)
        SONUM: 2.4,                // toplanırken sönümleme (büyük = daha hızlı oturur)
        SALINIM: 4.0,              // toplanırken salınım hızı
    };

    const canvas = document.getElementById("sahne");
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

    function hata(mesaj) {
        document.body.insertAdjacentHTML(
            "beforeend",
            '<p style="position:fixed;top:20px;left:20px;right:20px;color:#fff;font:16px sans-serif">' + mesaj + "</p>"
        );
    }

    const gl = canvas.getContext("webgl2", { antialias: false, alpha: false });
    if (!gl) { hata("Tarayıcın WebGL2 desteklemiyor."); return; }

    const VERT = `#version 300 es
    precision highp float;
    in vec2 aStartN;   // başlangıç konumu (0..1)
    in vec2 aGrid;     // fotoğraftaki hücre (x, y)
    in float aDelay;   // toplanmaya başlama zamanı
    in float aB;       // parlaklık 0..1
    in float aSeed;    // parçacığa özel rastgele sayı
    uniform vec2 uRes;
    uniform vec2 uOff;
    uniform float uCell;
    uniform float uTime;
    uniform float uSize;
    uniform float uChars;
    uniform float uGain;
    uniform float uDecay;
    uniform float uOsc;
    out float vIdx;
    out float vGray;

    // Beklerken parçacık olduğu yerde hafifçe süzülür
    vec2 bekle(float t, vec2 s) {
        float a = t * 0.9 + aSeed * 6.2831853;
        return s + vec2(sin(a * 1.7 + aSeed * 17.0), cos(a * 1.3 + aSeed * 11.0)) * uCell * 1.5;
    }

    void main() {
        vec2 s = aStartN * uRes;
        vec2 hedef = uOff + (aGrid + 0.5) * uCell;
        float tau = uTime - aDelay;
        vec2 pos;
        if (tau < 0.0) {
            pos = bekle(uTime, s);
        } else {
            // Sönümlü yay: hedefe gider, hafifçe aşar ve oturur
            float a = uDecay * (0.8 + 0.5 * aSeed);
            float e = exp(-a * tau);
            float k = e * (cos(uOsc * tau) + (a / uOsc) * sin(uOsc * tau));
            pos = hedef + (bekle(aDelay, s) - hedef) * k;
        }
        pos = floor(pos + 0.5);
        gl_Position = vec4(pos.x / uRes.x * 2.0 - 1.0, 1.0 - pos.y / uRes.y * 2.0, 0.0, 1.0);
        gl_PointSize = uSize;
        vIdx = min(uChars - 1.0, floor(aB * uChars));
        vGray = clamp((0.3 + 0.7 * aB) * uGain, 0.0, 1.0);
    }`;

    const FRAG = `#version 300 es
    precision highp float;
    uniform sampler2D uAtlas;
    uniform float uChars;
    in float vIdx;
    in float vGray;
    out vec4 renk;
    void main() {
        vec2 uv = vec2((vIdx + gl_PointCoord.x) / uChars, gl_PointCoord.y);
        float a = texture(uAtlas, uv).a;
        renk = vec4(vec3(vGray), a);
    }`;

    function shader(tip, kaynak) {
        const s = gl.createShader(tip);
        gl.shaderSource(s, kaynak);
        gl.compileShader(s);
        if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
            throw new Error(gl.getShaderInfoLog(s));
        }
        return s;
    }

    let prog, vao, n = 0, cols, rows, bitis = 8;
    let t0 = performance.now(), raf = 0, rt;
    const U = {};

    const img = new Image();
    img.onload = basla;
    img.onerror = () => hata("Fotoğraf yüklenemedi: photo-data.js dosyasını kontrol et.");
    img.src = PHOTO_DATA;

    function basla() {
        try {
            prog = gl.createProgram();
            gl.attachShader(prog, shader(gl.VERTEX_SHADER, VERT));
            gl.attachShader(prog, shader(gl.FRAGMENT_SHADER, FRAG));
            gl.linkProgram(prog);
            if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(prog));
        } catch (e) {
            hata("Shader hatası: " + e.message);
            return;
        }
        gl.useProgram(prog);
        ["uRes", "uOff", "uCell", "uTime", "uSize", "uChars", "uGain", "uDecay", "uOsc", "uAtlas"]
            .forEach((ad) => (U[ad] = gl.getUniformLocation(prog, ad)));

        parcaciklariKur();
        atlasYap();

        gl.uniform1f(U.uChars, AYAR.KARAKTERLER.length);
        gl.uniform1f(U.uGain, AYAR.PARLAKLIK);
        gl.uniform1f(U.uDecay, AYAR.SONUM);
        gl.uniform1f(U.uOsc, AYAR.SALINIM);
        gl.uniform1i(U.uAtlas, 0);
        gl.enable(gl.BLEND);
        gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);

        boyutla();
        t0 = performance.now();
        iste();
    }

    // Fotoğrafı hücrelere böler; her hücre bir parçacık olur.
    function parcaciklariKur() {
        const oran = img.width / img.height;
        rows = Math.round(Math.sqrt(AYAR.PARCACIK / oran));
        cols = Math.round(rows * oran);

        const k = document.createElement("canvas");
        k.width = cols;
        k.height = rows;
        const kc = k.getContext("2d", { willReadFrequently: true });
        kc.imageSmoothingQuality = "high";
        kc.drawImage(img, 0, 0, cols, rows);
        const veri = kc.getImageData(0, 0, cols, rows).data;

        const AD = 7; // parçacık başına float sayısı
        const tampon = new Float32Array(cols * rows * AD);
        let m = 0, maxGecikme = 0;
        for (let y = 0; y < rows; y++) {
            for (let x = 0; x < cols; x++) {
                let b = veri[(y * cols + x) * 4] / 255;
                b = Math.min(1, Math.max(0, (b - 0.04) / 0.92));
                b = Math.pow(b, AYAR.GAMA);
                if (b < AYAR.ESIK) continue;
                const gecikme = reduce ? 0 : AYAR.BASLANGIC_BEKLEME + (x / cols) * AYAR.TARAMA_SURESI + Math.random() * 0.5;
                maxGecikme = Math.max(maxGecikme, gecikme);
                const o = m * AD;
                tampon[o] = Math.random();       // aStartN.x
                tampon[o + 1] = Math.random();   // aStartN.y
                tampon[o + 2] = x;               // aGrid.x
                tampon[o + 3] = y;               // aGrid.y
                tampon[o + 4] = gecikme;         // aDelay
                tampon[o + 5] = b;               // aB
                tampon[o + 6] = Math.random();   // aSeed
                m++;
            }
        }
        n = m;
        bitis = maxGecikme + 4.5; // bu süreden sonra çizim durur (pil tasarrufu)

        vao = gl.createVertexArray();
        gl.bindVertexArray(vao);
        const buf = gl.createBuffer();
        gl.bindBuffer(gl.ARRAY_BUFFER, buf);
        gl.bufferData(gl.ARRAY_BUFFER, tampon.subarray(0, n * AD), gl.STATIC_DRAW);

        const adim = AD * 4;
        [["aStartN", 2, 0], ["aGrid", 2, 8], ["aDelay", 1, 16], ["aB", 1, 20], ["aSeed", 1, 24]]
            .forEach(([ad, boyut, ofset]) => {
                const loc = gl.getAttribLocation(prog, ad);
                gl.enableVertexAttribArray(loc);
                gl.vertexAttribPointer(loc, boyut, gl.FLOAT, false, adim, ofset);
            });
    }

    // Karakterleri tek bir dokuda (atlas) yan yana çizer; shader buradan örnekler.
    function atlasYap() {
        const GS = 32, kar = AYAR.KARAKTERLER;
        const c = document.createElement("canvas");
        c.width = GS * kar.length;
        c.height = GS;
        const g = c.getContext("2d");
        g.fillStyle = "#fff";
        g.font = `bold ${Math.round(GS * 0.85)}px "Courier New", monospace`;
        g.textAlign = "center";
        g.textBaseline = "middle";
        for (let i = 0; i < kar.length; i++) {
            g.save();
            g.translate(GS * i + GS / 2, GS / 2);
            g.scale(1.4, 1);
            g.fillText(kar[i], 0, 0);
            g.restore();
        }
        const tex = gl.createTexture();
        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D, tex);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, c);
        gl.generateMipmap(gl.TEXTURE_2D);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    }

    function boyutla() {
        const dpr = Math.min(window.devicePixelRatio || 1, 2);
        const W = (canvas.width = Math.floor(innerWidth * dpr));
        const H = (canvas.height = Math.floor(innerHeight * dpr));
        gl.viewport(0, 0, W, H);
        const cell = Math.min((W * 0.94) / cols, (H * 0.92) / rows);
        gl.uniform2f(U.uRes, W, H);
        gl.uniform2f(U.uOff, (W - cell * cols) / 2, (H - cell * rows) / 2);
        gl.uniform1f(U.uCell, cell);
        gl.uniform1f(U.uSize, Math.max(2, Math.round(cell * AYAR.KARAKTER_BOYUTU)));
    }

    function kare(now) {
        raf = 0;
        const t = reduce ? 1000 : (now - t0) / 1000;
        gl.clearColor(0, 0, 0, 1);
        gl.clear(gl.COLOR_BUFFER_BIT);
        gl.uniform1f(U.uTime, t);
        gl.drawArrays(gl.POINTS, 0, n);
        if (t < bitis) iste();
    }

    function iste() {
        if (!raf) raf = requestAnimationFrame(kare);
    }

    window.addEventListener("keydown", (e) => {
        if (e.code === "Space" && n) { 
            e.preventDefault(); 
            t0 = performance.now(); 
            iste(); 
        }
    });
    window.addEventListener("resize", () => {
        clearTimeout(rt);
        rt = setTimeout(() => { 
            if (n) { 
                boyutla(); 
                iste(); 
            } 
        }, 150);
    });
})();