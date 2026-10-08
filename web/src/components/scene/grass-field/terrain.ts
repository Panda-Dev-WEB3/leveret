// 📖 Docs: obsidian/frontend/components/scene.md

/**
 * Deterministic terrain for the grass field.
 *
 * One 32-bit seed fixes the whole meadow. Two independent streams derive from
 * it: `SEED` shuffles the simplex permutation table (the relief), and
 * `SEED ^ 0x9e3779b9` drives the blade layout — so the field reproduces exactly
 * on every load and every geometry rebuild. No `Math.random()` may enter scene
 * generation.
 */

/** Small, fast, seedable PRNG. Returns a function producing [0, 1). */
export const mulberry32 = (seed: number): (() => number) => {
  let a = seed;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
};

/**
 * 2D simplex noise (Gustavson, public domain), inlined rather than pulled from
 * `simplex-noise` because the constructor must accept an RNG — the permutation
 * shuffle has to be seeded for the relief to be reproducible.
 */
export class SimplexNoise {
  private readonly perm: Uint8Array;
  private readonly permMod12: Uint8Array;
  private readonly grad3: Float32Array;

  constructor(random: () => number = Math.random) {
    this.perm = new Uint8Array(512);
    this.permMod12 = new Uint8Array(512);

    const p = new Uint8Array(256);
    for (let i = 0; i < 256; i++) p[i] = i;
    for (let i = 255; i > 0; i--) {
      const n = Math.floor((i + 1) * random());
      const q = p[i];
      p[i] = p[n];
      p[n] = q;
    }
    for (let i = 0; i < 512; i++) {
      this.perm[i] = p[i & 255];
      this.permMod12[i] = this.perm[i] % 12;
    }

    // prettier-ignore
    this.grad3 = new Float32Array([
      1, 1, 0, -1, 1, 0, 1, -1, 0, -1, -1, 0,
      1, 0, 1, -1, 0, 1, 1, 0, -1, -1, 0, -1,
      0, 1, 1, 0, -1, 1, 0, 1, -1, 0, -1, -1,
    ]);
  }

  noise2D(xin: number, yin: number): number {
    const grad3 = this.grad3;
    const perm = this.perm;
    const permMod12 = this.permMod12;
    const F2 = 0.5 * (Math.sqrt(3) - 1);
    const G2 = (3 - Math.sqrt(3)) / 6;

    let n0 = 0;
    let n1 = 0;
    let n2 = 0;

    const s = (xin + yin) * F2;
    const i = Math.floor(xin + s);
    const j = Math.floor(yin + s);
    const t = (i + j) * G2;
    const x0 = xin - (i - t);
    const y0 = yin - (j - t);

    let i1: number;
    let j1: number;
    if (x0 > y0) {
      i1 = 1;
      j1 = 0;
    } else {
      i1 = 0;
      j1 = 1;
    }

    const x1 = x0 - i1 + G2;
    const y1 = y0 - j1 + G2;
    const x2 = x0 - 1 + 2 * G2;
    const y2 = y0 - 1 + 2 * G2;
    const ii = i & 255;
    const jj = j & 255;

    let t0 = 0.5 - x0 * x0 - y0 * y0;
    if (t0 >= 0) {
      const gi0 = permMod12[ii + perm[jj]] * 3;
      t0 *= t0;
      n0 = t0 * t0 * (grad3[gi0] * x0 + grad3[gi0 + 1] * y0);
    }
    let t1 = 0.5 - x1 * x1 - y1 * y1;
    if (t1 >= 0) {
      const gi1 = permMod12[ii + i1 + perm[jj + j1]] * 3;
      t1 *= t1;
      n1 = t1 * t1 * (grad3[gi1] * x1 + grad3[gi1 + 1] * y1);
    }
    let t2 = 0.5 - x2 * x2 - y2 * y2;
    if (t2 >= 0) {
      const gi2 = permMod12[ii + 1 + perm[jj + 1]] * 3;
      t2 *= t2;
      n2 = t2 * t2 * (grad3[gi2] * x2 + grad3[gi2 + 1] * y2);
    }

    return 70 * (n0 + n1 + n2);
  }
}

/** Samples the terrain height at a world XZ position. */
export type HeightSampler = (x: number, z: number) => number;

/** One simplex octave: how tall, and how wide its features are. */
export interface TerrainOctave {
  amplitude: number;
  scale: number;
}

/**
 * Sums the configured simplex octaves on the CPU. This is the single source of
 * truth for **both** the ground mesh and every blade's Y offset — which is why
 * the blades sit exactly on the surface instead of hovering or sinking, and why
 * retuning the relief moves the grass with it.
 */
export const createHeightSampler = (
  seed: number,
  octaves: readonly TerrainOctave[],
): HeightSampler => {
  const simplex = new SimplexNoise(mulberry32(seed));

  return (x, z) => {
    let y = 0;
    for (const octave of octaves) {
      y += octave.amplitude * simplex.noise2D(x / octave.scale, z / octave.scale);
    }
    return y;
  };
};

/**
 * A bare seeded 2D noise field, for things that are not terrain height —
 * grass-height clumping and per-blade variation patches. Seeded separately from
 * the relief so retuning one does not reshuffle the other.
 */
export const createNoise2D = (
  seed: number,
): ((x: number, y: number) => number) => {
  const simplex = new SimplexNoise(mulberry32(seed));
  return (x, y) => simplex.noise2D(x, y);
};

/**
 * Surface normal at a world XZ, by central difference on the height field.
 *
 * Used to bake a per-blade ground-light term: the blades are unlit geometry, so
 * without it a mound and the hollow beside it shade identically and the relief
 * reads flat no matter how good the silhouette is.
 */
export const terrainNormal = (
  sample: HeightSampler,
  x: number,
  z: number,
  epsilon = 0.75,
): { x: number; y: number; z: number } => {
  const dx = sample(x + epsilon, z) - sample(x - epsilon, z);
  const dz = sample(x, z + epsilon) - sample(x, z - epsilon);
  // Gradient -> normal, for a height field y = f(x, z).
  const nx = -dx;
  const ny = 2 * epsilon;
  const nz = -dz;
  const length = Math.hypot(nx, ny, nz);
  return { x: nx / length, y: ny / length, z: nz / length };
};
