// 📖 Docs: obsidian/frontend/components/scene.md

/**
 * Drifting motes over the field.
 *
 * One `THREE.Points` draw call. Every particle's wander, rise and twinkle is a
 * function of time and a per-particle seed evaluated in the vertex shader, so
 * nothing is written from the CPU per frame — the only per-frame cost is a
 * uniform update.
 *
 * They are bright and `toneMapped: false`, which puts them over the bloom
 * threshold: the glow around each mote is the bloom pass, not a sprite texture.
 */

import * as THREE from "three";

import { GRASS_FIELD_CONFIG as CONFIG } from "./grass-field.config";
import {
  PARTICLE_FRAGMENT_SHADER,
  PARTICLE_VERTEX_SHADER,
} from "./shaders";
import { mulberry32 } from "./terrain";

export interface ParticleHandle {
  object: THREE.Points;
  /** Exposed so the panel can retune them live. */
  uniforms: {
    uColor: THREE.IUniform<THREE.Color>;
    uBrightness: THREE.IUniform<number>;
    uSize: THREE.IUniform<number>;
    uSpeed: THREE.IUniform<number>;
    uRise: THREE.IUniform<number>;
    uDrift: THREE.IUniform<number>;
    uTwinkle: THREE.IUniform<number>;
    uTwinkleSpeed: THREE.IUniform<number>;
  };
  setTime: (elapsed: number) => void;
  setPixelRatio: (pixelRatio: number) => void;
  /** CSS size of the canvas — shrinks the motes on viewports below the reference. */
  setViewport: (width: number, height: number) => void;
  /** Draw only the first `count` motes — the buffer stays allocated. */
  setCount: (count: number) => void;
  dispose: () => void;
}

export const createParticles = (
  seed: number,
  center: THREE.Vector2,
  baseY: number,
): ParticleHandle => {
  const { particles } = CONFIG;

  const positions = new Float32Array(particles.count * 3);
  const seeds = new Float32Array(particles.count * 3);
  const random = mulberry32(seed);

  for (let i = 0; i < particles.count; i++) {
    // Scattered on a disc around the camera rather than in a box, for the same
    // reason the blades are: a box has corners the eye can find.
    const radius = particles.radius * Math.sqrt(random());
    const theta = random() * Math.PI * 2;
    positions[i * 3] = center.x + Math.cos(theta) * radius;
    positions[i * 3 + 1] = baseY + random() * particles.height;
    positions[i * 3 + 2] = center.y + Math.sin(theta) * radius;

    seeds[i * 3] = random();
    seeds[i * 3 + 1] = random();
    seeds[i * 3 + 2] = random();
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute("seed", new THREE.BufferAttribute(seeds, 3));

  const timeUniform: THREE.IUniform<number> = { value: 0 };
  const pixelRatioUniform: THREE.IUniform<number> = { value: 1 };
  const viewportScaleUniform: THREE.IUniform<number> = { value: 1 };
  const uniforms = {
    uColor: { value: new THREE.Color(particles.color) },
    uBrightness: { value: particles.brightness } as THREE.IUniform<number>,
    uSize: { value: particles.size } as THREE.IUniform<number>,
    uSpeed: { value: particles.speed } as THREE.IUniform<number>,
    uRise: { value: particles.rise } as THREE.IUniform<number>,
    uDrift: { value: particles.drift } as THREE.IUniform<number>,
    uTwinkle: { value: particles.twinkle } as THREE.IUniform<number>,
    uTwinkleSpeed: {
      value: particles.twinkleSpeed,
    } as THREE.IUniform<number>,
    uTime: timeUniform,
    uPixelRatio: pixelRatioUniform,
    uViewportScale: viewportScaleUniform,
    uBaseY: { value: baseY },
    uHeight: { value: particles.height },
  };

  const material = new THREE.ShaderMaterial({
    uniforms,
    vertexShader: PARTICLE_VERTEX_SHADER,
    fragmentShader: PARTICLE_FRAGMENT_SHADER,
    transparent: true,
    blending: THREE.AdditiveBlending,
    // Depth *test* on so the hill occludes them; depth *write* off so they never
    // occlude each other into hard edges.
    depthWrite: false,
    toneMapped: false,
  });

  const points = new THREE.Points(geometry, material);
  // Positions are animated in the shader, so the bounding sphere three computes
  // from the buffer is wrong the moment the clock starts.
  points.frustumCulled = false;

  return {
    object: points,
    uniforms: {
      uColor: uniforms.uColor,
      uBrightness: uniforms.uBrightness,
      uSize: uniforms.uSize,
      uSpeed: uniforms.uSpeed,
      uRise: uniforms.uRise,
      uDrift: uniforms.uDrift,
      uTwinkle: uniforms.uTwinkle,
      uTwinkleSpeed: uniforms.uTwinkleSpeed,
    },
    setTime: (elapsed) => {
      timeUniform.value = elapsed;
    },
    setPixelRatio: (pixelRatio) => {
      pixelRatioUniform.value = pixelRatio;
    },
    setCount: (count) => {
      geometry.setDrawRange(0, Math.max(0, Math.min(count, particles.count)));
    },
    setViewport: (width, height) => {
      const { width: refWidth, height: refHeight } = particles.referenceViewport;
      const scale = Math.min(width / refWidth, height / refHeight, 1);
      viewportScaleUniform.value = Math.max(scale, particles.minViewportScale);
    },
    dispose: () => {
      geometry.dispose();
      material.dispose();
    },
  };
};
