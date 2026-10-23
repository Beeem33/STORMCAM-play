/**
 * The "camera sensor": everything between the HDR scene and the pixels
 * looks like it came out of a consumer dashcam or phone.
 *
 *  1. barrel distortion (dashcam wide lens)
 *  2. refraction through windshield water (from the glass pass)
 *  3. camera motion blur reconstructed from depth (vehicle interior excluded)
 *  4. auto exposure, filmic tone curve, restrained grade
 *  5. light sharpening halo, luminance-dependent sensor noise, vignette
 */
export const POST_VERTEX = /* glsl */ `
varying vec2 vUv;
void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }
`;

export const POST_FRAGMENT = /* glsl */ `
precision highp float;
uniform sampler2D tScene;
uniform sampler2D tDepth;
uniform sampler2D tGlass;
uniform sampler2D tNoise;
uniform vec2 uTexel;
uniform float uTime;
uniform float uExposure;
uniform float uBarrel;
uniform float uChroma;
uniform float uNoise;
uniform float uSharpen;
uniform float uVignette;
uniform float uSaturation;
uniform float uContrast;
uniform vec3 uTint;
uniform float uBlur;          // shutter fraction 0..1, 0 disables
uniform mat4 uInvViewProj;
uniform mat4 uPrevViewProj;
uniform float uGlassVeil;     // how much light the dirty glass scatters
uniform float uFade;          // fade to black
uniform float uFlashWhite;    // sensor blowout on a very close strike
uniform float uDamage;        // red-tinged edge when hurt (bodycam only)
varying vec2 vUv;

vec3 acesFitted(vec3 x) {
  const float a = 2.51, b = 0.03, c = 2.43, d = 0.59, e = 0.14;
  return clamp((x * (a * x + b)) / (x * (c * x + d) + e), 0.0, 1.0);
}
vec3 toSRGB(vec3 c) {
  return mix(c * 12.92, 1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055, step(0.0031308, c));
}
float hash(vec2 p) { return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453); }

void main() {
  // 1. Lens: barrel distortion that keeps the corners filled.
  vec2 uv = vUv;
  vec2 cc = uv - 0.5;
  float aspect = uTexel.y / uTexel.x;
  vec2 ca = cc * vec2(aspect, 1.0);
  float r2 = dot(ca, ca);
  float rMax2 = 0.25 * (aspect * aspect + 1.0);
  float k = uBarrel;
  float scale = (1.0 + k * r2) / (1.0 + k * rMax2);
  uv = 0.5 + cc * scale;

  // 2. Windshield water: refraction offset + droplet mask.
  vec4 glass = texture2D(tGlass, uv);
  vec2 off = (glass.rg - 0.5) * 0.11 * glass.b;
  vec2 suv = clamp(uv + off, vec2(0.001), vec2(0.999));
  float interior = glass.a;

  // 3. Motion blur from camera motion.
  vec3 col = texture2D(tScene, suv).rgb;
  if (uBlur > 0.0 && interior < 0.5) {
    float depth = texture2D(tDepth, suv).r;
    vec4 ndc = vec4(suv * 2.0 - 1.0, depth * 2.0 - 1.0, 1.0);
    vec4 wp = uInvViewProj * ndc;
    wp /= wp.w;
    vec4 prev = uPrevViewProj * wp;
    vec2 puv = prev.xy / prev.w * 0.5 + 0.5;
    vec2 vel = (suv - puv) * uBlur;
    float len = length(vel / uTexel);
    if (len > 1.5) {
      vel *= min(1.0, 40.0 / len);
      vec3 acc = col;
      float wsum = 1.0;
      float j = hash(gl_FragCoord.xy + uTime) - 0.5;
      for (int i = 1; i <= 6; i++) {
        float t = (float(i) + j) / 6.0 - 0.5;
        vec2 suv2 = suv + vel * t;
        float w = texture2D(tGlass, suv2).a < 0.5 ? 1.0 : 0.0;
        acc += texture2D(tScene, suv2).rgb * w;
        wsum += w;
      }
      col = acc / wsum;
    }
  }

  // Chromatic fringe toward the frame edge (cheap lens).
  if (uChroma > 0.0) {
    // Applied as a delta so it doesn't undo the motion blur.
    vec2 dir = (suv - 0.5) * uChroma * r2;
    vec3 c0 = texture2D(tScene, suv).rgb;
    col.r = max(0.0, col.r + (texture2D(tScene, suv + dir).r - c0.r) * 0.85);
    col.b = max(0.0, col.b + (texture2D(tScene, suv - dir).b - c0.b) * 0.85);
  }

  // Unsharp mask — the slightly crunchy look of in-camera sharpening.
  vec3 nb = texture2D(tScene, suv + vec2(uTexel.x, 0.0)).rgb + texture2D(tScene, suv - vec2(uTexel.x, 0.0)).rgb
          + texture2D(tScene, suv + vec2(0.0, uTexel.y)).rgb + texture2D(tScene, suv - vec2(0.0, uTexel.y)).rgb;
  col = max(col + (col - nb * 0.25) * uSharpen, 0.0);

  // Glass veil: dirt and water scatter the bright sky across the windshield.
  float lumIn = dot(col, vec3(0.2126, 0.7152, 0.0722));
  col += vec3(0.85, 0.9, 0.95) * uGlassVeil * (0.25 + glass.b * 0.9) * (1.0 - interior) * 0.12;
  // Droplets: a darker body and a bright rim that reflects the sky above.
  {
    float slope = length((glass.rg - 0.5) * 2.0);
    float rim = smoothstep(0.45, 0.95, slope) * smoothstep(0.15, 0.5, glass.b) * (1.0 - interior);
    vec3 skyAbove = texture2D(tScene, clamp(suv + vec2(0.0, 0.18), 0.0, 1.0)).rgb;
    col *= 1.0 - glass.b * 0.14 * (1.0 - interior);
    col += skyAbove * rim * 0.35;
  }

  // 4. Exposure + tone.
  col *= uExposure;
  col += uFlashWhite;
  col = acesFitted(col);
  float l = dot(col, vec3(0.2126, 0.7152, 0.0722));
  col = mix(vec3(l), col, uSaturation);
  col = (col - 0.5) * uContrast + 0.5;
  col *= uTint;
  // Teal-ish shadows, neutral highlights.
  col += (vec3(-0.006, 0.004, 0.01)) * (1.0 - smoothstep(0.0, 0.5, l));
  col = clamp(col, 0.0, 1.0);

  // 5. Sensor noise, stronger in the shadows and when exposure is pushed.
  float gainNoise = uNoise * (0.55 + 0.45 * clamp(uExposure / 6.0, 0.0, 2.0));
  vec2 np = gl_FragCoord.xy / 256.0 + vec2(fract(uTime * 17.31), fract(uTime * 9.17));
  float nL = (texture2D(tNoise, np).a + texture2D(tNoise, np * 1.37 + 0.31).a - 1.0);
  vec3 nC = vec3(texture2D(tNoise, np + 0.5).a, texture2D(tNoise, np + 0.25).a, texture2D(tNoise, np + 0.75).a) - 0.5;
  float shadowWeight = 1.0 - smoothstep(0.05, 0.65, l);
  col += (nL * 0.8 + 0.0) * gainNoise * (0.35 + shadowWeight);
  col += nC * gainNoise * 0.35 * shadowWeight;

  // Vignette.
  float vig = smoothstep(0.25, 1.1, length(cc * vec2(aspect, 1.0)) * 1.25);
  col *= 1.0 - vig * uVignette;
  col = mix(col, col * vec3(0.6, 0.15, 0.1), uDamage * vig);

  col *= 1.0 - uFade;
  gl_FragColor = vec4(toSRGB(clamp(col, 0.0, 1.0)), 1.0);
}
`;

/** Downsample used for auto exposure: average log luminance. */
export const LUMA_FRAGMENT = /* glsl */ `
precision highp float;
uniform sampler2D tScene;
uniform sampler2D tDepth;
uniform sampler2D tGlass;
uniform vec2 uSrcTexel;
uniform float uNear;
uniform float uFar;
varying vec2 vUv;
// Meter the world, not what's right in front of the lens: the car interior
// (glass alpha = 1) and anything nearer than ~20 m (the truck beside you on
// foot, the road at your feet) count for almost nothing, so the exposure is
// the same in the cab and on foot.
void main() {
  float acc = 0.0, wsum = 0.0;
  for (int y = -2; y <= 2; y++)
    for (int x = -2; x <= 2; x++) {
      vec2 uv = vUv + vec2(float(x), float(y)) * uSrcTexel * 3.0;
      float d = texture2D(tDepth, uv).r;
      float viewZ = uNear * uFar / (uFar - d * (uFar - uNear));
      float w = (1.0 - texture2D(tGlass, uv).a * 0.97) * mix(0.03, 1.0, smoothstep(10.0, 25.0, viewZ));
      vec3 c = texture2D(tScene, uv).rgb;
      acc += log(max(dot(c, vec3(0.2126, 0.7152, 0.0722)), 1e-4)) * w;
      wsum += w;
    }
  gl_FragColor = vec4(acc, wsum, 0.0, 1.0);
}
`;
