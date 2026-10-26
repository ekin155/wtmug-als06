// DTMF frekans tablosu (satır x sütun)
const DTMF_ROWS = [697, 770, 852, 941];
const DTMF_COLS = [1209, 1336, 1477, 1633];
const DTMF_KEYS = [
  ['1','2','3','A'],
  ['4','5','6','B'],
  ['7','8','9','C'],
  ['*','0','#','D']
];
// Sadece rakam üreteceğimiz için key -> (row, col) haritası
const KEY_MAP = {};
DTMF_KEYS.forEach((row, r) => row.forEach((k, c) => { KEY_MAP[k] = { r, c }; }));

// ---- ÜRETİM (Hoca) ----
// 650ms ton + 350ms sessizlik
const TONE_MS = 650, GAP_MS = 350, SR = 44100;

function playDigit(audioCtx, digit) {
  const { r, c } = KEY_MAP[digit];
  const f1 = DTMF_ROWS[r], f2 = DTMF_COLS[c];
  const n = Math.floor(SR * TONE_MS / 1000);
  const buf = audioCtx.createBuffer(1, n, SR);
  const data = buf.getChannelData(0);
  for (let i = 0; i < n; i++) {
    const t = i / SR;
    // Pencere (kenar yumuşatma)
    const w = Math.min(1, Math.min(i, n - i) / 220);
    data[i] = 0.35 * w * (Math.sin(2 * Math.PI * f1 * t) + Math.sin(2 * Math.PI * f2 * t));
  }
  const src = audioCtx.createBufferSource();
  src.buffer = buf;
  src.connect(audioCtx.destination);
  src.start();
}

async function playCode(audioCtx, code4) {
  for (const ch of code4) {
    playDigit(audioCtx, ch);
    await new Promise(r => setTimeout(r, TONE_MS + GAP_MS));
  }
}

// ---- ÇÖZÜM (Öğrenci) — Goertzel ----
// Belirli bir pencere için 8 DTMF frekansının enerjisini hesapla
function goertzelPower(samples, targetFreq, sampleRate) {
  const N = samples.length;
  const k = Math.round(0.5 + (N * targetFreq) / sampleRate);
  const omega = (2 * Math.PI * k) / N;
  const coeff = 2 * Math.cos(omega);
  let s0 = 0, s1 = 0, s2 = 0;
  for (let i = 0; i < N; i++) {
    s0 = samples[i] + coeff * s1 - s2;
    s2 = s1; s1 = s0;
  }
  return s1 * s1 + s2 * s2 - coeff * s1 * s2;
}

// 1024 örnek (~23ms) pencere yeterli. En iyi satır ve en iyi sütunu bul.
function detectDigit(samples, sampleRate) {
  let bestRow = -1, bestRowP = 0;
  DTMF_ROWS.forEach((f, i) => {
    const p = goertzelPower(samples, f, sampleRate);
    if (p > bestRowP) { bestRowP = p; bestRow = i; }
  });
  let bestCol = -1, bestColP = 0;
  DTMF_COLS.forEach((f, i) => {
    const p = goertzelPower(samples, f, sampleRate);
    if (p > bestColP) { bestColP = p; bestCol = i; }
  });
  // Eşik: enerji ortalamanın üstünde olmalı (basit eşik)
  if (bestRowP < 1e6 || bestColP < 1e6) return null;
  return DTMF_KEYS[bestRow][bestCol];
}

// ---- Durum makinesi: 4 hane topla, sessizlikte sıfırla ----
class DTMFDecoder {
  constructor(onCode) {
    this.buffer = '';
    this.lastDigitTime = 0;
    this.onCode = onCode;
    this.silenceFrames = 0;
  }
  // Her ~23ms'de bir çağrılır
  feed(samples, sampleRate, now) {
    const digit = detectDigit(samples, sampleRate);
    if (digit !== null) {
      // Yeni ton başlangıcı mı? (aynı hanenin tekrarını engelle)
      if (now - this.lastDigitTime > 200) {
        this.buffer += digit;
        this.lastDigitTime = now;
        this.silenceFrames = 0;
        if (this.buffer.length === 4) {
          this.onCode(this.buffer);
          // QR üretildikten sonra dinlemeye devam; buffer'ı sıfırla
          this.buffer = '';
        }
      }
    } else {
      this.silenceFrames++;
      // 350ms+ sessizlik → yarım kalan kodu sıfırla
      if (this.silenceFrames > 15 && this.buffer.length > 0 && now - this.lastDigitTime > 400) {
        this.buffer = '';
      }
    }
  }
}