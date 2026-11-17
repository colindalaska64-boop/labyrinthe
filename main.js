import * as THREE from "three";
import { PointerLockControls } from "three/addons/controls/PointerLockControls.js";

/* =========================================================
   CONFIG — modifie ces valeurs pour ajuster le jeu
   ========================================================= */
const CELL = 4;           // taille d'une case du labyrinthe
const WALL_HEIGHT = 3;
const EYE_HEIGHT = 1.6;
let PLAYER_SPEED = 5; // écrasé par la config (curseur "Vitesse du joueur" de l'éditeur)
const PLAYER_RADIUS = 0.3;

const MAX_GHOSTS = 4;        // nombre max de fantômes actifs en même temps
const GHOST_HEIGHT = 1.4;    // hauteur du sprite du fantôme
const GHOST_SCALE = 2;
const GHOST_SPEED = 2.5;

const DETECT_RADIUS = 9;     // distance à partir de laquelle le fantôme "s'approche" (le son se joue)
const AMBUSH_LOOKAHEAD = 4;  // cases visées devant le joueur par le comportement "ambush"
const FLEE_TRIGGER_DIST = 5; // distance (en cases) sous laquelle "flee" s'enfuit et fuit
const CURIOUS_WANDER_CHANCE = 0.2; // proba qu'une errance interne choisisse la case la plus proche du joueur
const SENTINEL_WAKE_DIST = 6;      // distance (unités monde) à laquelle "sentinel" se réveille
const SENTINEL_SLEEP_DIST = 11;    // distance à laquelle "sentinel" se rendort
const ERRATIC_DASH_CHANCE = 0.25;  // proba que "erratic" parte en sprint vers une case aléatoire
const TELEPORT_MIN_DELAY = 60;     // secondes min avant un téléport de "teleporter"
const TELEPORT_MAX_DELAY = 60;     // secondes max avant un téléport de "teleporter"

const STAR_INTERVAL = 90;          // secondes entre deux étoiles (très rare)
const STAR_WINDUP = 2;             // secondes où il fonce déjà sur toi, avant que l'étoile s'active pour de vrai
const STAR_DURATION = 20;          // durée de l'effet une fois activé
const STAR_SPEED_MULTIPLIER = 3;   // vitesse pendant l'étoile

const MAX_HEALTH = 100;
// Rayon de contact = la moitié de la taille réelle du sprite du fantôme +
// le rayon du joueur, au lieu d'un rayon fixe : un gros fantôme touche de
// plus loin, un petit doit vraiment te toucher — et ça laisse une vraie
// place pour esquiver en se collant à l'opposé du couloir.
function ghostContactRadius(ghost) {
  return ghost.scale / 2 + PLAYER_RADIUS;
}
const DAMAGE_PER_SECOND = 40;  // dégâts par seconde de contact, par défaut (réglable par fantôme dans l'éditeur)

const GHOST_MAX_HP = MAX_HEALTH * 3; // 3x notre vie : il faut s'acharner pour en tuer un
const FIRE_RATE = 10;          // tirs par seconde en tenant le clic
const BULLET_DAMAGE = 1;       // dégâts par balle (10 tirs/s * 1 * 30s = 300 = GHOST_MAX_HP : ~30s de tir précis minimum pour tuer)
const GUN_RANGE = 30;          // portée du tir (unités monde)

/* =========================================================
   LABYRINTHE — 1 case = "#" (mur) ou "." (libre)
   Généré (avec une graine fixe, donc toujours le même) pour avoir une
   grande map sans avoir à dessiner une grille géante à la main.
   ========================================================= */
const MAZE_SIZE = 19; // nombre de cases par côté (impair)

function mulberry32(seed) {
  return function () {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function generateMaze(size) {
  const rng = mulberry32(1337);
  const grid = Array.from({ length: size }, () => Array(size).fill("#"));

  function carve(r, c) {
    grid[r][c] = ".";
    const dirs = [[0, 2], [0, -2], [2, 0], [-2, 0]];
    for (let i = dirs.length - 1; i > 0; i--) {
      const j = Math.floor(rng() * (i + 1));
      [dirs[i], dirs[j]] = [dirs[j], dirs[i]];
    }
    for (const [dr, dc] of dirs) {
      const nr = r + dr;
      const nc = c + dc;
      if (nr > 0 && nr < size - 1 && nc > 0 && nc < size - 1 && grid[nr][nc] === "#") {
        grid[r + dr / 2][c + dc / 2] = ".";
        carve(nr, nc);
      }
    }
  }

  carve(1, 1);
  return grid.map((row) => row.join(""));
}

const MAZE = generateMaze(MAZE_SIZE).map((row) => row.split(""));

const ROWS = MAZE.length;
const COLS = MAZE[0].length;

function isWallCell(row, col) {
  if (row < 0 || row >= ROWS || col < 0 || col >= COLS) return true;
  return MAZE[row][col] === "#";
}

// Vrai si rien ne bloque la vue entre deux points du labyrinthe (ligne
// droite échantillonnée tous les quarts de case). Sert à ne jouer le son
// d'un fantôme que si on le voit vraiment, pas à travers les murs.
function hasLineOfSight(ax, az, bx, bz) {
  const dist = Math.hypot(bx - ax, bz - az);
  const steps = Math.max(1, Math.ceil(dist / (CELL / 4)));
  for (let i = 1; i < steps; i++) {
    const t = i / steps;
    if (isWallCell(Math.round((az + (bz - az) * t) / CELL), Math.round((ax + (bx - ax) * t) / CELL))) {
      return false;
    }
  }
  return true;
}

function openCells() {
  const cells = [];
  for (let r = 0; r < ROWS; r++) {
    for (let c = 0; c < COLS; c++) {
      if (!isWallCell(r, c)) cells.push({ row: r, col: c });
    }
  }
  return cells;
}

function pickRandomOpenCell(exclude) {
  const candidates = openCells().filter(
    (c) => !exclude || c.row !== exclude.row || c.col !== exclude.col
  );
  return candidates[Math.floor(Math.random() * candidates.length)];
}

function neighborsOf(row, col) {
  const dirs = [
    [0, 1],
    [0, -1],
    [1, 0],
    [-1, 0],
  ];
  const result = [];
  for (const [dr, dc] of dirs) {
    const r = row + dr;
    const c = col + dc;
    if (!isWallCell(r, c)) result.push({ row: r, col: c });
  }
  return result;
}

function cellToWorld(row, col) {
  return { x: col * CELL, z: row * CELL };
}

function worldToCell(x, z) {
  return { row: Math.round(z / CELL), col: Math.round(x / CELL) };
}

/* =========================================================
   SCENE / CAMERA / RENDERER
   ========================================================= */
const scene = new THREE.Scene();
scene.fog = new THREE.Fog(0x000000, 4, 22);

const camera = new THREE.PerspectiveCamera(
  75,
  window.innerWidth / window.innerHeight,
  0.1,
  100
);
scene.add(camera); // ajouté à la scène pour que la "lampe" attachée éclaire bien

const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setSize(window.innerWidth, window.innerHeight);
document.body.appendChild(renderer.domElement);

window.addEventListener("resize", () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
});

// Lumière d'ambiance faible + "lampe" qui suit le joueur
scene.add(new THREE.AmbientLight(0x404050, 1.3));
const flashlight = new THREE.PointLight(0xffffff, 1.2, 16);
camera.add(flashlight);

/* =========================================================
   CONSTRUCTION DU LABYRINTHE (murs + sol)
   ========================================================= */
const wallGeometry = new THREE.BoxGeometry(CELL, WALL_HEIGHT, CELL);
const wallMaterial = new THREE.MeshStandardMaterial({ color: 0x2b2f77 });

const backroomsWallpaper = new THREE.TextureLoader().load("assets/branding/backrooms-wallpaper.jpg");
backroomsWallpaper.wrapS = THREE.RepeatWrapping;
backroomsWallpaper.wrapT = THREE.RepeatWrapping;
backroomsWallpaper.repeat.set(2, 1); // se répète sur chaque mur, façon papier peint
const backroomsWallMaterial = new THREE.MeshStandardMaterial({ map: backroomsWallpaper });
const wallMeshes = [];

for (let r = 0; r < ROWS; r++) {
  for (let c = 0; c < COLS; c++) {
    if (isWallCell(r, c)) {
      const { x, z } = cellToWorld(r, c);
      const wall = new THREE.Mesh(wallGeometry, wallMaterial);
      wall.position.set(x, WALL_HEIGHT / 2, z);
      scene.add(wall);
      wallMeshes.push(wall);
    }
  }
}

const floorGeometry = new THREE.PlaneGeometry(COLS * CELL, ROWS * CELL);
const floorMaterial = new THREE.MeshStandardMaterial({ color: 0x111111 });
const floor = new THREE.Mesh(floorGeometry, floorMaterial);
floor.rotation.x = -Math.PI / 2;
floor.position.set(((COLS - 1) * CELL) / 2, 0, ((ROWS - 1) * CELL) / 2);
scene.add(floor);

// Plafond + néons, cachés tant qu'on n'est pas dans les backrooms.
const ceiling = new THREE.Mesh(floorGeometry, new THREE.MeshStandardMaterial({ color: 0xcfc27a }));
ceiling.rotation.x = Math.PI / 2;
ceiling.position.set(((COLS - 1) * CELL) / 2, WALL_HEIGHT, ((ROWS - 1) * CELL) / 2);
ceiling.visible = false;
scene.add(ceiling);

const backroomsLights = new THREE.Group();
for (let r = 1; r < ROWS - 1; r += 3) {
  for (let c = 1; c < COLS - 1; c += 3) {
    if (!isWallCell(r, c)) {
      const light = new THREE.PointLight(0xfff4c2, 1.4, 10);
      const { x, z } = cellToWorld(r, c);
      light.position.set(x, WALL_HEIGHT - 0.2, z);
      backroomsLights.add(light);
    }
  }
}

/* =========================================================
   JOUEUR / CONTROLES (souris + ZQSD/WASD)
   ========================================================= */
const controls = new PointerLockControls(camera, renderer.domElement);

const spawn = cellToWorld(1, 1);
camera.position.set(spawn.x, EYE_HEIGHT, spawn.z);

// Position "logique" du joueur, utilisée pour tout le mouvement/collisions.
// camera.position affiche cette position + le décalage du tremblement
// d'écran (voir updateScreenShake) : sans cette séparation, un tremblement
// pouvait pousser la caméra dans un mur et bloquer le joueur pour de vrai.
const playerPos = new THREE.Vector3(spawn.x, EYE_HEIGHT, spawn.z);

const overlay = document.getElementById("overlay");
overlay.addEventListener("click", () => controls.lock());
document.getElementById("admin-link")?.addEventListener("click", (e) => e.stopPropagation());

// Difficulté : change juste des multiplicateurs appliqués aux fantômes à
// leur création (voir spawnGhost), sauf pour "hard" qui autorise en plus
// l'étoile (sinon elle n'apparaît jamais).
const DIFFICULTIES = {
  easy: { label: "Facile", speedMult: 0.7, damageMult: 0.6, detectMult: 0.8, allowStar: false },
  medium: { label: "Moyen", speedMult: 1, damageMult: 1, detectMult: 1, allowStar: false },
  hard: { label: "AHHHHHH", speedMult: 1.5, damageMult: 1.6, detectMult: 1.3, allowStar: true },
};
let selectedDifficulty = "medium";

for (const btn of document.querySelectorAll(".difficulty-btn")) {
  if (btn.dataset.difficulty === selectedDifficulty) btn.classList.add("selected");
  btn.addEventListener("click", (e) => {
    e.stopPropagation(); // sinon ça déclenche aussi le clic sur l'overlay (verrouille direct)
    selectedDifficulty = btn.dataset.difficulty;
    for (const b of document.querySelectorAll(".difficulty-btn")) b.classList.toggle("selected", b === btn);
  });
}
const bgm = document.getElementById("bgm");

// Les fantômes ne sont créés qu'au tout premier démarrage (pas au
// chargement de la page), pour que la difficulté choisie sur l'écran
// d'accueil soit bien celle utilisée — sinon ils existaient déjà avant
// même que le joueur ait pu cliquer sur un bouton.
let gameStarted = false;

controls.addEventListener("lock", async () => {
  overlay.classList.add("hidden");

  if (!gameStarted) {
    gameStarted = true;
    await loadGhosts();
    // Tiré une seule fois, au lancement (pas à chaque reprise après une pause),
    // et jamais à la toute première partie sur ce navigateur.
    const firstGame = countGameAndCheckFirst();
    if (!firstGame && Math.random() < BACKROOMS_CHANCE) enterBackrooms();
  }

  bgm.volume = inBackrooms ? 0.75 : 0.25;
  if (inBackrooms) boostBgm(BACKROOMS_MUSIC_BOOST);
  bgm.play().catch(() => {});
  for (const ghost of ghosts) {
    if (ghost.starred && ghost.starAudio) ghost.starAudio.play().catch(() => {});
  }
});
controls.addEventListener("unlock", () => {
  // Une fois la partie finie, c'est l'écran de mort/victoire qui s'affiche, pas le menu.
  if (!gameOver) overlay.classList.remove("hidden");
  pauseGameAudio();
});

// Coupe la musique et les sons des fantômes (pause, mort, victoire). Les sons
// des fantômes repartent tout seuls à la reprise (voir updateGhosts).
function pauseGameAudio() {
  bgm.pause();
  for (const ghost of ghosts) {
    if (ghost.audio) ghost.audio.pause();
    if (ghost.starAudio) ghost.starAudio.pause();
  }
}

/* =========================================================
   BACKROOMS — mode secret (1 chance sur 3 au lancement sauf à la
   toute première partie, ou en
   martelant "avancer" 4 fois dans un coin en L)
   ========================================================= */
const BACKROOMS_CHANCE = 1 / 3;
const GAMES_PLAYED_KEY = "pacman3d-parties-jouees";

// Compte les parties lancées sur ce navigateur (gardé entre deux "Rejouer").
// Renvoie true pour la toute première. Si le navigateur refuse de stocker
// (navigation privée...), on fait comme si ce n'était pas la première.
function countGameAndCheckFirst() {
  try {
    const played = parseInt(localStorage.getItem(GAMES_PLAYED_KEY) || "0", 10) || 0;
    localStorage.setItem(GAMES_PLAYED_KEY, String(played + 1));
    return played === 0;
  } catch {
    return false;
  }
}
const CORNER_PRESSES_NEEDED = 4;
const CORNER_PRESS_WINDOW = 1.5; // secondes pour enchaîner les 4 appuis

let inBackrooms = false;
let worldSpeedMultiplier = 1;
let cornerPressCount = 0;
let cornerPressTimer = 0;

function isCornerCell(row, col) {
  const up = !isWallCell(row - 1, col);
  const down = !isWallCell(row + 1, col);
  const left = !isWallCell(row, col - 1);
  const right = !isWallCell(row, col + 1);
  if ([up, down, left, right].filter(Boolean).length !== 2) return false;
  return (up || down) && (left || right); // coin en L, pas un couloir droit
}

// Musique des backrooms 50 % plus forte. Le volume d'un <audio> ne peut pas
// dépasser 1 : on passe donc la musique par un amplificateur (Web Audio).
const BACKROOMS_MUSIC_BOOST = 1.5;
let bgmGain = null;
function boostBgm(gain) {
  try {
    const ctx = getExplosionAudioCtx();
    if (!bgmGain) {
      bgmGain = ctx.createGain();
      ctx.createMediaElementSource(bgm).connect(bgmGain).connect(ctx.destination);
    }
    bgmGain.gain.value = gain;
    if (ctx.state === "suspended") ctx.resume().catch(() => {});
  } catch (e) {
    console.warn("Amplification de la musique impossible :", e);
  }
}

function enterBackrooms() {
  if (inBackrooms) return;
  inBackrooms = true;
  worldSpeedMultiplier = 2;

  for (const wall of wallMeshes) wall.material = backroomsWallMaterial;
  ceiling.visible = true;
  scene.add(backroomsLights);
  scene.fog.color.set(0x4a4324);
  scene.fog.near = 3;
  scene.fog.far = 15;

  maxHealth = MAX_HEALTH + 50;
  health = Math.min(health + 50, maxHealth);
  updateHealthBar();

  bgm.src = "assets/branding/undertale-megalovania.mp3";
  bgm.currentTime = 0;
  bgm.volume = 0.75;
  boostBgm(BACKROOMS_MUSIC_BOOST);
  bgm.play().catch(() => {});
}

window.addEventListener("keydown", (e) => {
  if (inBackrooms || e.repeat) return;
  if (e.code !== "KeyZ" && e.code !== "KeyW" && e.code !== "ArrowUp") return;

  const cell = worldToCell(camera.position.x, camera.position.z);
  if (!isCornerCell(cell.row, cell.col)) {
    cornerPressCount = 0;
    return;
  }
  cornerPressCount++;
  cornerPressTimer = CORNER_PRESS_WINDOW;
  if (cornerPressCount >= CORNER_PRESSES_NEEDED) {
    cornerPressCount = 0;
    enterBackrooms();
  }
});

// Logo qui rebondit n'importe comment sur l'écran d'accueil, façon DVD
// mais en pire : rotation, grossissement, tout en même temps.
const logo = document.getElementById("logo");
const LOGO_FREEZE_MS = 3000; // reste statique le temps que la page s'installe
const logoStartTime = performance.now();
let logoX = 50, logoY = 50, logoVX = 140, logoVY = 95, logoAngle = 0, logoScale = 1, logoScaleDir = 1, logoHue = 0;
let lastLogoTime = performance.now();
function animateLogo(now) {
  requestAnimationFrame(animateLogo);
  if (overlay.classList.contains("hidden")) return;

  if (now - logoStartTime < LOGO_FREEZE_MS) {
    logo.style.left = "50%";
    logo.style.top = "20%";
    logo.style.transform = "translate(-50%, -50%)";
    lastLogoTime = now;
    return;
  }

  const dt = Math.min((now - lastLogoTime) / 1000, 0.1);
  lastLogoTime = now;

  const w = logo.offsetWidth * logoScale;
  const h = logo.offsetHeight * logoScale;
  logoX += logoVX * dt;
  logoY += logoVY * dt;
  if (logoX <= 0 || logoX + w >= window.innerWidth) logoVX *= -1;
  if (logoY <= 0 || logoY + h >= window.innerHeight) logoVY *= -1;
  logoX = Math.max(0, Math.min(window.innerWidth - w, logoX));
  logoY = Math.max(0, Math.min(window.innerHeight - h, logoY));

  // Coups de vitesse aléatoires, en plus du rebond classique, façon "n'importe quoi".
  if (Math.random() < dt * 0.6) {
    logoVX = (Math.random() - 0.5) * 600;
    logoVY = (Math.random() - 0.5) * 600;
  }

  logoAngle += 400 * dt;
  logoScale += logoScaleDir * 0.6 * dt;
  if (logoScale > 4 || logoScale < 0.6) logoScaleDir *= -1;
  logoHue = (logoHue + 260 * dt) % 360;

  const skew = Math.sin(now / 180) * 25;
  const flip = Math.sin(now / 260) > 0 ? -1 : 1;

  logo.style.left = `${logoX}px`;
  logo.style.top = `${logoY}px`;
  logo.style.transform = `rotate(${logoAngle}deg) scale(${logoScale}) skew(${skew}deg) scaleX(${flip})`;
  logo.style.filter = `hue-rotate(${logoHue}deg) saturate(3)`;
}
requestAnimationFrame(animateLogo);

const keys = { forward: false, back: false, left: false, right: false };

window.addEventListener("keydown", (e) => setKey(e.code, true));
window.addEventListener("keyup", (e) => setKey(e.code, false));

function setKey(code, value) {
  switch (code) {
    case "KeyW":
    case "KeyZ":
    case "ArrowUp":
      keys.forward = value;
      break;
    case "KeyS":
    case "ArrowDown":
      keys.back = value;
      break;
    case "KeyA":
    case "KeyQ":
    case "ArrowLeft":
      keys.left = value;
      break;
    case "KeyD":
    case "ArrowRight":
      keys.right = value;
      break;
  }
}

function canStandAt(x, z) {
  const r = PLAYER_RADIUS;
  const points = [
    [x - r, z - r],
    [x + r, z - r],
    [x - r, z + r],
    [x + r, z + r],
  ];
  return points.every(([px, pz]) => {
    const col = Math.round(px / CELL);
    const row = Math.round(pz / CELL);
    return !isWallCell(row, col);
  });
}

const forward = new THREE.Vector3();
const right = new THREE.Vector3();
const up = new THREE.Vector3(0, 1, 0);

function updatePlayer(delta) {
  if (!controls.isLocked) return;

  camera.getWorldDirection(forward);
  forward.y = 0;
  forward.normalize();
  right.crossVectors(forward, up).normalize();

  let dx = 0;
  let dz = 0;
  if (keys.forward) {
    dx += forward.x;
    dz += forward.z;
  }
  if (keys.back) {
    dx -= forward.x;
    dz -= forward.z;
  }
  if (keys.right) {
    dx += right.x;
    dz += right.z;
  }
  if (keys.left) {
    dx -= right.x;
    dz -= right.z;
  }

  const len = Math.hypot(dx, dz);
  if (len > 0) {
    const step = PLAYER_SPEED * worldSpeedMultiplier * delta;
    dx = (dx / len) * step;
    dz = (dz / len) * step;

    // déplacement testé axe par axe pour glisser le long des murs
    if (canStandAt(playerPos.x + dx, playerPos.z)) {
      playerPos.x += dx;
    }
    if (canStandAt(playerPos.x, playerPos.z + dz)) {
      playerPos.z += dz;
    }
  }
}

/* =========================================================
   ARMES — mitraillette (clic gauche) + grenade (clic droit)
   ========================================================= */
const raycaster = new THREE.Raycaster();
raycaster.far = GUN_RANGE;
const textureLoader = new THREE.TextureLoader();

let firing = false;
let fireCooldown = 0;

// Bruit de mitraillette (assets/branding) : joué en boucle tant que le tir
// est maintenu, plutôt que rejoué à chaque balle (fichier trop long pour ça).
const gunSound = new Audio("assets/branding/machine-gun-burst.mp3");
gunSound.loop = true;
gunSound.volume = 0.5;

function startFiring() {
  firing = true;
  gunSound.currentTime = 0;
  gunSound.play().catch(() => {});
}
function stopFiring() {
  firing = false;
  gunSound.pause();
}

document.addEventListener("mousedown", (e) => {
  if (!controls.isLocked) return;
  if (e.button === 0) startFiring();
  else if (e.button === 2) throwGrenade();
});
document.addEventListener("mouseup", (e) => {
  if (e.button === 0) stopFiring();
});
document.addEventListener("contextmenu", (e) => e.preventDefault()); // pas de menu clic-droit pendant le jeu
controls.addEventListener("unlock", stopFiring);

const gunEl = document.getElementById("gun");
const crosshairEl = document.getElementById("crosshair");

// Impact de balle : l'image fournie (assets/arme/mitrallete), posée bien à
// plat sur ce qui a été touché (parallèle au mur, pas un panneau qui nous
// fait toujours face) — sauf sur un fantôme, où il n'y a pas de "mur" à
// épouser, donc il fait face à la caméra comme avant.
// On la réduit dans un petit canvas puis on la ré-agrandit avec un filtre
// adouci (pas de filtre "au plus proche") : texture basse résolution +
// léger flou, comme les vieux jeux (GameCube/360). On en profite pour
// rendre transparent son fond blanc.
const IMPACT_PIXEL_SIZE = 16;
const impactTexture = textureLoader.load("assets/arme/mitrallete/impact.png", (tex) => {
  const canvas = document.createElement("canvas");
  canvas.width = IMPACT_PIXEL_SIZE;
  canvas.height = IMPACT_PIXEL_SIZE;
  const ctx = canvas.getContext("2d");
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(tex.image, 0, 0, IMPACT_PIXEL_SIZE, IMPACT_PIXEL_SIZE);

  const imgData = ctx.getImageData(0, 0, IMPACT_PIXEL_SIZE, IMPACT_PIXEL_SIZE);
  const data = imgData.data;
  for (let i = 0; i < data.length; i += 4) {
    const dr = 255 - data[i];
    const dg = 255 - data[i + 1];
    const db = 255 - data[i + 2];
    if (Math.sqrt(dr * dr + dg * dg + db * db) < 60) data[i + 3] = 0; // fond blanc -> transparent
  }
  ctx.putImageData(imgData, 0, 0);

  tex.image = canvas;
  tex.needsUpdate = true;
});
impactTexture.magFilter = THREE.LinearFilter; // flou léger à l'agrandissement, pas de gros pixels nets
impactTexture.minFilter = THREE.LinearFilter;
impactTexture.generateMipmaps = false;
const IMPACT_SCALE = 0.3;   // 0.4 réduit de 25%
const IMPACT_OFFSET = 0.05; // ~3 pixels de décalage, sinon ça clignote (z-fighting) sur le mur
const impactGeometry = new THREE.PlaneGeometry(1, 1);

// Uniquement pour un mur (immobile) : jamais appelée pour un fantôme, qui
// bougerait et laisserait la marque flotter derrière lui dans le vide.
function spawnBulletImpact(point, hit) {
  const material = new THREE.MeshBasicMaterial({ map: impactTexture, transparent: true, side: THREE.DoubleSide });
  const mark = new THREE.Mesh(impactGeometry, material);
  mark.scale.set(IMPACT_SCALE, IMPACT_SCALE, 1);
  mark.position.copy(point);

  const worldNormal = hit.face.normal.clone().transformDirection(hit.object.matrixWorld);
  mark.position.addScaledVector(worldNormal, IMPACT_OFFSET);
  // aligne le plan sur la normale du mur touché, au lieu de nous faire face
  mark.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), worldNormal);

  scene.add(mark);
  setTimeout(() => scene.remove(mark), 4000);
}

// Traînée de balle : une ligne très courte entre l'arme et le point touché.
function spawnBulletTracer(from, to) {
  const geometry = new THREE.BufferGeometry().setFromPoints([from, to]);
  const material = new THREE.LineBasicMaterial({ color: 0xfff59d, transparent: true, opacity: 0.9 });
  const line = new THREE.Line(geometry, material);
  scene.add(line);
  setTimeout(() => scene.remove(line), 80);
}

// Flash rouge bref sur un fantôme quand il perd de la vie (balle ou grenade).
function flashGhostRed(ghost) {
  ghost.sprite.material.color.setHex(0xff3333);
  clearTimeout(ghost.hitFlashTimer);
  ghost.hitFlashTimer = setTimeout(() => {
    if (ghost.sprite.material) ghost.sprite.material.color.setHex(0xffffff);
  }, 150);
}

function damageGhost(ghost, amount) {
  ghost.hp -= amount;
  flashGhostRed(ghost);
  if (ghost.hp <= 0) killGhost(ghost);
}

function killGhost(ghost) {
  scene.remove(ghost.sprite);
  if (ghost.audio) ghost.audio.pause();
  if (ghost.starAudio) ghost.starAudio.pause(); // sinon le son de l'étoile boucle à l'infini
  const i = ghosts.indexOf(ghost);
  if (i !== -1) ghosts.splice(i, 1);
}

function shoot() {
  gunEl.classList.add("recoil");
  setTimeout(() => gunEl.classList.remove("recoil"), 60);

  // Sans ça, le rayon peut viser la position du fantôme d'il y a une frame
  // (matrices pas encore recalculées) et le rater alors qu'il est en plein
  // dans le viseur.
  scene.updateMatrixWorld();
  raycaster.setFromCamera({ x: 0, y: 0 }, camera);
  const targets = [...ghosts.map((g) => g.sprite), ...wallMeshes];
  const hits = raycaster.intersectObjects(targets);

  const tracerEnd = hits.length > 0
    ? hits[0].point
    : raycaster.ray.origin.clone().addScaledVector(raycaster.ray.direction, GUN_RANGE);
  spawnBulletTracer(raycaster.ray.origin, tracerEnd);

  if (hits.length === 0) return;
  const hit = hits[0];
  const hitGhost = ghosts.find((g) => g.sprite === hit.object);

  // Pas de marque d'impact sur un fantôme : comme il continue de bouger,
  // elle resterait plantée dans le vide derrière lui (le flash rouge suffit
  // comme retour visuel). Seuls les murs, immobiles, gardent une marque.
  if (!hitGhost) spawnBulletImpact(hit.point, hit);

  if (hitGhost) {
    damageGhost(hitGhost, BULLET_DAMAGE);
    crosshairEl.classList.add("hit");
    setTimeout(() => crosshairEl.classList.remove("hit"), 60);
  }
}

function updateWeapon(delta) {
  fireCooldown -= delta;
  if (firing && controls.isLocked && fireCooldown <= 0) {
    fireCooldown = 1 / FIRE_RATE;
    shoot();
  }
}

/* =========================================================
   GRENADE — clic droit : lancée devant soi, explose 3s après
   ========================================================= */
const GRENADE_SPEED = 12;
const GRENADE_FUSE = 3;        // secondes avant explosion
const GRENADE_SPIN_SPEED = 8;  // rad/s, tourne sur elle-même en vol
const GRENADE_BLAST_RADIUS = 6;
const GRENADE_DAMAGE = 200;    // gros dégâts, comme demandé
const GRENADE_SCALE = 0.6;
const GRENADE_COOLDOWN = 5;    // secondes entre deux grenades

let grenadeTexture = null;
let grenadeCooldown = 0;

// grenade.jpg n'a pas de transparence (JPG) : on enlève le fond nous-mêmes
// en rendant transparents les pixels proches de la couleur du coin
// haut-gauche (même technique que "Fond transparent" dans l'éditeur).
async function loadGrenadeTexture() {
  const img = new Image();
  img.src = "assets/arme/grenade/grenade.jpg";
  await img.decode();

  const canvas = document.createElement("canvas");
  canvas.width = img.naturalWidth;
  canvas.height = img.naturalHeight;
  const ctx = canvas.getContext("2d");
  ctx.drawImage(img, 0, 0);

  const imgData = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const data = imgData.data;
  const [r0, g0, b0] = data;
  for (let i = 0; i < data.length; i += 4) {
    const dr = data[i] - r0;
    const dg = data[i + 1] - g0;
    const db = data[i + 2] - b0;
    if (Math.sqrt(dr * dr + dg * dg + db * db) < 40) data[i + 3] = 0;
  }
  ctx.putImageData(imgData, 0, 0);
  return new THREE.CanvasTexture(canvas);
}
loadGrenadeTexture().then((tex) => (grenadeTexture = tex));

const grenades = [];

function throwGrenade() {
  if (!grenadeTexture || grenadeCooldown > 0) return;
  grenadeCooldown = GRENADE_COOLDOWN;

  const material = new THREE.SpriteMaterial({ map: grenadeTexture, transparent: true });
  const sprite = new THREE.Sprite(material);
  sprite.scale.set(GRENADE_SCALE, GRENADE_SCALE, 1);
  sprite.position.copy(camera.position);
  scene.add(sprite);

  const dir = new THREE.Vector3();
  camera.getWorldDirection(dir);

  grenades.push({
    sprite,
    velocity: dir.multiplyScalar(GRENADE_SPEED).add(new THREE.Vector3(0, 3, 0)),
    fuse: GRENADE_FUSE,
    grounded: false,
  });
}

function explodeGrenade(position) {
  spawnExplosionVideo(position);
  triggerScreenShake();

  for (const ghost of ghosts.slice()) {
    const inRange = ghost.sprite.position.distanceTo(position) <= GRENADE_BLAST_RADIUS;
    // Les murs arrêtent l'explosion.
    if (inRange && hasLineOfSight(position.x, position.z, ghost.sprite.position.x, ghost.sprite.position.z)) {
      damageGhost(ghost, GRENADE_DAMAGE);
    }
  }
}

// Tremblement de caméra (façon secousse sismique) pendant SHAKE_DURATION.
// Un nouveau décalage aléatoire à chaque frame = tremblement ultra rapide.
// Important : ça ne touche QUE `shakeOffset`, jamais playerPos/camera.position
// directement — sinon une secousse peut pousser la caméra dans un mur (pas
// de vérification de collision ici) et le joueur se retrouve bloqué pour de
// vrai au frame suivant. La position affichée finale (playerPos + décalage)
// est recomposée une seule fois par frame, à la fin de la boucle.
const SHAKE_DURATION = 0.5;
const SHAKE_MAGNITUDE = 0.6; // secousse forte, sans faiblir jusqu'à la fin des 0.5s
let shakeTime = 0;
const shakeOffset = new THREE.Vector3();

function triggerScreenShake() {
  shakeTime = SHAKE_DURATION;
}

function updateScreenShake(delta) {
  if (shakeTime > 0) {
    shakeTime -= delta;
    const mag = SHAKE_MAGNITUDE; // pleine intensité pendant toute la durée, pas de fondu
    shakeOffset.set((Math.random() * 2 - 1) * mag, (Math.random() * 2 - 1) * mag, (Math.random() * 2 - 1) * mag);
  } else {
    shakeOffset.set(0, 0, 0);
  }
}

// Vidéo d'explosion (fond vert) affichée en incrustation : un shader tout
// simple qui rend transparents les pixels verts de la vidéo, comme un vrai
// fond vert. Se retire toute seule à la fin de la vidéo.
const explosionVideos = [];

let explosionAudioCtx = null;
function getExplosionAudioCtx() {
  if (!explosionAudioCtx) explosionAudioCtx = new (window.AudioContext || window.webkitAudioContext)();
  return explosionAudioCtx;
}

// Courbe de saturation classique (waveshaper) : écrase/déforme le son au
// lieu de juste monter le volume, pour un rendu plus "impact" d'explosion.
function makeDistortionCurve(amount) {
  const samples = 44100;
  const curve = new Float32Array(samples);
  const deg = Math.PI / 180;
  for (let i = 0; i < samples; i++) {
    const x = (i * 2) / samples - 1;
    curve[i] = ((3 + amount) * x * 20 * deg) / (Math.PI + amount * Math.abs(x));
  }
  return curve;
}

function spawnExplosionVideo(position) {
  const video = document.createElement("video");
  video.src = "assets/arme/grenade/explosion.mp4";
  video.playsInline = true;
  video.loop = false;
  video.play().catch(() => {});

  // Son de la vidéo passé par la Web Audio API : saturé (waveshaper) puis
  // ré-amplifié un peu, plutôt qu'un simple volume monté.
  const audioCtx = getExplosionAudioCtx();
  const source = audioCtx.createMediaElementSource(video);
  const shaper = audioCtx.createWaveShaper();
  shaper.curve = makeDistortionCurve(35);
  shaper.oversample = "4x";
  const gain = audioCtx.createGain();
  gain.gain.value = 1.4;
  source.connect(shaper).connect(gain).connect(audioCtx.destination);

  const texture = new THREE.VideoTexture(video);
  const material = new THREE.ShaderMaterial({
    uniforms: { map: { value: texture } },
    vertexShader: `
      varying vec2 vUv;
      void main() {
        vUv = uv;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `,
    fragmentShader: `
      varying vec2 vUv;
      uniform sampler2D map;
      void main() {
        vec4 color = texture2D(map, vUv);
        float greenness = color.g - max(color.r, color.b);
        if (greenness > 0.15) discard; // pixel du fond vert : on ne le dessine pas
        gl_FragColor = color;
      }
    `,
    transparent: true,
    depthWrite: false,
    side: THREE.DoubleSide,
  });

  const mesh = new THREE.Mesh(new THREE.PlaneGeometry(5, 5), material);
  mesh.position.copy(position);
  mesh.position.y += 1.8; // sinon la moitié est sous le sol, on ne voit pas tout
  scene.add(mesh);

  const entry = { video, mesh };
  explosionVideos.push(entry);
  video.addEventListener("ended", () => {
    scene.remove(mesh);
    const i = explosionVideos.indexOf(entry);
    if (i !== -1) explosionVideos.splice(i, 1);
  });
}

function updateExplosionVideos() {
  for (const { mesh } of explosionVideos) mesh.lookAt(camera.position);
}

function updateGrenades(delta) {
  if (grenadeCooldown > 0) grenadeCooldown -= delta;

  for (let i = grenades.length - 1; i >= 0; i--) {
    const g = grenades[i];
    g.fuse -= delta;
    g.sprite.material.rotation += GRENADE_SPIN_SPEED * delta;

    if (!g.grounded) {
      g.velocity.y -= 9.8 * delta;
      const next = g.sprite.position.clone().addScaledVector(g.velocity, delta);
      if (!canStandAt(next.x, next.z)) {
        // Contre un mur : reste hors du mur et retombe au sol.
        next.x = g.sprite.position.x;
        next.z = g.sprite.position.z;
        g.velocity.x = 0;
        g.velocity.z = 0;
      }
      if (next.y <= 0.3) {
        next.y = 0.3;
        g.grounded = true;
        g.velocity.set(0, 0, 0);
      }
      g.sprite.position.copy(next);
    }

    if (g.fuse <= 0) {
      explodeGrenade(g.sprite.position.clone());
      scene.remove(g.sprite);
      grenades.splice(i, 1);
    }
  }
}

/* =========================================================
   FANTOMES — images importées depuis assets/ghosts
   ========================================================= */
function shuffle(array) {
  const copy = [...array];
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
}

// Comportements des fantômes. Choisis-en un par fantôme dans l'éditeur
// (admin.html) via ghost.behavior. Pour ajouter un nouveau comportement,
// ajoute simplement une fonction ici (et une entrée dans la liste
// BEHAVIORS de admin.js pour pouvoir le sélectionner dans l'interface).
const ghostBehaviors = {
  // Poursuit le joueur en suivant le vrai plus court chemin dans le
  // labyrinthe (recalculé à chaque case atteinte, puisque le joueur bouge).
  // Le comportement le plus simple et le plus redoutable à distance.
  chase(ghost, delta) {
    const arrived = !ghost.target || moveToward(ghost, delta);
    if (arrived) followPath(ghost, worldToCell(camera.position.x, camera.position.z));
  },

  // Vise quelques cases devant le joueur (dans la direction où il regarde)
  // plutôt que sa position actuelle, pour essayer de lui couper la route
  // avant qu'il n'arrive.
  ambush(ghost, delta) {
    const arrived = !ghost.target || moveToward(ghost, delta);
    if (arrived) followPath(ghost, predictedPlayerCell(AMBUSH_LOOKAHEAD));
  },

  // Poursuit activement le joueur tant qu'il est loin (comme "chase"),
  // mais panique et fuit dans la direction opposée dès qu'il devient trop
  // proche — un comportement peureux mais sournois.
  flee(ghost, delta) {
    const arrived = !ghost.target || moveToward(ghost, delta);
    if (!arrived) return;

    const playerCell = worldToCell(camera.position.x, camera.position.z);
    const options = neighborsOf(ghost.cell.row, ghost.cell.col);
    if (options.length === 0) return;

    // Hystérésis (comme "sentinel") pour éviter d'osciller à chaque case
    // pile à la distance limite : une fois en fuite, il ne repart en
    // chasse qu'une fois vraiment loin.
    const dist = cellDist(ghost.cell, playerCell);
    if (dist < FLEE_TRIGGER_DIST) ghost.fleeing = true;
    else if (dist > FLEE_TRIGGER_DIST * 1.6) ghost.fleeing = false;

    if (ghost.fleeing) {
      options.sort((a, b) => cellDist(b, playerCell) - cellDist(a, playerCell));
      pickTargetCell(ghost, [options[0]]);
    } else {
      followPath(ghost, playerCell);
    }
  },

  // Reste immobile et silencieux jusqu'à ce que le joueur s'approche, puis
  // se réveille et fonce sur lui en plus court chemin. Se rendort si le
  // joueur s'éloigne suffisamment. Fait office d'embuscade/jump-scare.
  sentinel(ghost, delta) {
    const dist = ghost.sprite.position.distanceTo(camera.position);
    if (dist < SENTINEL_WAKE_DIST) ghost.awake = true;
    else if (dist > SENTINEL_SLEEP_DIST) ghost.awake = false;

    if (!ghost.awake) return;

    const arrived = !ghost.target || moveToward(ghost, delta);
    if (arrived) followPath(ghost, worldToCell(camera.position.x, camera.position.z));
  },

  // Erre normalement la plupart du temps, mais part de temps en temps en
  // sprint imprévisible vers une case aléatoire du labyrinthe (pas
  // forcément liée au joueur) avant de reprendre son errance. Chaotique et
  // difficile à anticiper.
  erratic(ghost, delta) {
    const arrived = !ghost.target || moveToward(ghost, delta);
    if (!arrived) return;

    if (Math.random() < ERRATIC_DASH_CHANCE) {
      const cells = openCells();
      followPath(ghost, cells[Math.floor(Math.random() * cells.length)]);
    } else {
      wanderStep(ghost);
    }
  },

  // Te poursuit normalement, mais de temps en temps (rarement) se
  // téléporte directement devant toi sans prévenir. Effet de surprise garanti.
  teleporter(ghost, delta) {
    ghost.teleportTimer = (ghost.teleportTimer || 0) + delta;
    if (ghost.nextTeleport === undefined) {
      ghost.nextTeleport = TELEPORT_MIN_DELAY + Math.random() * (TELEPORT_MAX_DELAY - TELEPORT_MIN_DELAY);
    }

    if (ghost.teleportTimer >= ghost.nextTeleport) {
      ghost.teleportTimer = 0;
      ghost.nextTeleport = TELEPORT_MIN_DELAY + Math.random() * (TELEPORT_MAX_DELAY - TELEPORT_MIN_DELAY);
      let cell = predictedPlayerCell(2);
      if (isWallCell(cell.row, cell.col)) cell = worldToCell(camera.position.x, camera.position.z);
      ghost.cell = cell;
      ghost.target = null;
      const { x, z } = cellToWorld(cell.row, cell.col);
      ghost.sprite.position.set(x, GHOST_HEIGHT, z);
      return;
    }

    const arrived = !ghost.target || moveToward(ghost, delta);
    if (arrived) followPath(ghost, worldToCell(camera.position.x, camera.position.z));
  },
};

// Choisit la prochaine case d'une errance "naturelle" : évite de faire
// demi-tour sauf en cul-de-sac, et de temps en temps préfère la case qui
// rapproche le plus du joueur plutôt qu'un choix uniformément aléatoire.
function wanderStep(ghost) {
  const options = neighborsOf(ghost.cell.row, ghost.cell.col);
  const notBackwards = ghost.previousCell
    ? options.filter((c) => !sameCell(c, ghost.previousCell))
    : options;
  const pool = notBackwards.length > 0 ? notBackwards : options;

  ghost.previousCell = ghost.cell;

  if (Math.random() < CURIOUS_WANDER_CHANCE) {
    const playerCell = worldToCell(camera.position.x, camera.position.z);
    const curious = [...pool].sort((a, b) => cellDist(a, playerCell) - cellDist(b, playerCell));
    pickTargetCell(ghost, [curious[0]]);
  } else {
    pickTargetCell(ghost, pool);
  }
}

function sameCell(a, b) {
  return a.row === b.row && a.col === b.col;
}

function cellDist(a, b) {
  return Math.hypot(a.row - b.row, a.col - b.col);
}

// Case visée par "ambush" : quelques cases devant le joueur, dans la
// direction (haut/bas/gauche/droite) la plus proche de son regard actuel.
function predictedPlayerCell(lookahead) {
  const playerCell = worldToCell(camera.position.x, camera.position.z);
  const dRow = Math.abs(forward.z) >= Math.abs(forward.x) ? Math.sign(forward.z) || 1 : 0;
  const dCol = dRow === 0 ? Math.sign(forward.x) || 1 : 0;

  let { row, col } = playerCell;
  for (let i = 0; i < lookahead; i++) {
    const nr = row + dRow;
    const nc = col + dCol;
    if (isWallCell(nr, nc)) break;
    row = nr;
    col = nc;
  }
  return { row, col };
}

// Avance ghost.target d'une case le long du plus court chemin vers targetCell.
function followPath(ghost, targetCell) {
  if (isWallCell(targetCell.row, targetCell.col)) {
    pickTargetCell(ghost, neighborsOf(ghost.cell.row, ghost.cell.col));
    return;
  }
  const path = bfsPath(ghost.cell, targetCell);
  if (path && path.length > 1) {
    pickTargetCell(ghost, [path[1]]);
  } else {
    pickTargetCell(ghost, neighborsOf(ghost.cell.row, ghost.cell.col));
  }
}

// Plus court chemin (en nombre de cases) entre deux cases du labyrinthe.
function bfsPath(start, target) {
  if (sameCell(start, target)) return [start];

  const key = (c) => `${c.row},${c.col}`;
  const visited = new Set([key(start)]);
  const queue = [[start]];

  for (let head = 0; head < queue.length; head++) {
    const path = queue[head];
    const cur = path[path.length - 1];
    for (const next of neighborsOf(cur.row, cur.col)) {
      const k = key(next);
      if (visited.has(k)) continue;
      visited.add(k);
      const newPath = [...path, next];
      if (sameCell(next, target)) return newPath;
      queue.push(newPath);
    }
  }
  return null;
}

function pickTargetCell(ghost, options) {
  if (options.length === 0) return;
  const next = options[Math.floor(Math.random() * options.length)];
  const prevCell = ghost.cell;
  ghost.cell = next;
  const { x, z } = cellToWorld(next.row, next.col);
  const target = new THREE.Vector3(x, GHOST_HEIGHT, z);

  // Le fantôme longe un côté du couloir plutôt que la ligne centrale. Le
  // "côté" choisi (lateralBias) est gardé sur plusieurs cases au lieu
  // d'être retiré à chaque fois, sinon ça vibre au lieu de se voir vraiment
  // — il ne change de côté que de temps en temps.
  if (ghost.lateralBias === undefined || Math.random() < 0.3) {
    ghost.lateralBias = Math.random() * 2 - 1;
  }
  const maxOffset = Math.max(0, CELL / 2 - ghost.scale / 2 - 0.1);
  const lateral = ghost.lateralBias * maxOffset;
  if (next.row === prevCell.row) target.z += lateral; // déplacement horizontal -> décalage en Z
  else target.x += lateral; // déplacement vertical -> décalage en X

  ghost.target = target;
}

// Déplace le sprite vers ghost.target. Retourne true si la case cible est atteinte.
function moveToward(ghost, delta) {
  if (!ghost.target) return true;

  const pos = ghost.sprite.position;
  const dx = ghost.target.x - pos.x;
  const dz = ghost.target.z - pos.z;
  const dist = Math.hypot(dx, dz);

  if (dist < 0.15) return true;

  const step = Math.min(ghost.speed * worldSpeedMultiplier * delta, dist);
  pos.x += (dx / dist) * step;
  pos.z += (dz / dist) * step;
  return false;
}

const ghosts = [];
let fullGhostConfigs = []; // tous les fantômes de la config, sans la limite maxGhosts (pour la vague finale)
let hadGhosts = false;
let allGhostsDefeated = false;
let finalWaveStarted = false;

// Choisit un fichier au hasard dans le "sac à sons" du fantôme et le joue.
// Appelée à chaque fois qu'il s'approche, et à chaque fois qu'un son se
// termine tant qu'il reste proche — donc un fantôme avec plusieurs sons
// enchaîne des sons différents tirés au hasard tant qu'il est là.
function playRandomGhostSound(ghost) {
  if (!ghost.audio || ghost.soundPool.length === 0) return;
  const file = ghost.soundPool[Math.floor(Math.random() * ghost.soundPool.length)];
  ghost.audio.src = `assets/sounds/${encodeURIComponent(file)}`;
  ghost.audio.play().catch(() => {});
}

function spawnGhost({ image, sounds, sound, behavior, speed, scale, detectRadius, damage, volume, hp, cell }) {
  const { x, z } = cellToWorld(cell.row, cell.col);

  const texture = textureLoader.load(`assets/ghosts/${image}`, undefined, undefined, () => {
    console.warn(
      `Image de fantôme introuvable : "${image}" (assets/ghosts/${image}). ` +
        `Le fichier a peut-être été renommé/supprimé depuis l'éditeur — ` +
        `réassigne l'image dans l'éditeur puis réenregistre la configuration.`
    );
  });
  const material = new THREE.SpriteMaterial({ map: texture, transparent: true });
  const sprite = new THREE.Sprite(material);
  const s = scale || GHOST_SCALE;
  sprite.scale.set(s, s, 1);
  sprite.position.set(x, GHOST_HEIGHT, z);
  scene.add(sprite);

  // Liste de sons choisis dans l'éditeur (nouveau format `sounds`, tableau).
  // Si absente, on retombe sur l'ancien format `sound` (un seul fichier),
  // et si rien n'est précisé, sur tout le dossier assets/sounds.
  // Vide = pas de son pour ce fantôme (avant : retombait sur tout le dossier).
  const soundPool = sounds && sounds.length > 0 ? sounds : sound ? [sound] : [];

  const difficulty = DIFFICULTIES[selectedDifficulty];

  const ghost = {
    image,
    sprite,
    cell,
    previousCell: null,
    target: null,
    behavior: behavior || "chase",
    speed: (speed || GHOST_SPEED) * difficulty.speedMult,
    detectRadius: (detectRadius || DETECT_RADIUS) * difficulty.detectMult,
    damage: (damage || DAMAGE_PER_SECOND) * difficulty.damageMult,
    scale: s,
    hp: hp || GHOST_MAX_HP, // vie réglable par fantôme dans config.json ("hp"), sinon 300
    volume: volume ?? 1,
    soundPool,
    audio: null,
    isNear: false,
  };

  if (soundPool.length > 0) {
    ghost.audio = new Audio();
    // Pas de `loop` : quand un son se termine, on en relance un autre tiré
    // au hasard tant que le fantôme est toujours proche (voir updateGhosts).
    ghost.audio.addEventListener("ended", () => {
      if (ghost.isNear) playRandomGhostSound(ghost);
    });
  }

  ghosts.push(ghost);
}

// Charge les fantômes définis dans l'éditeur (admin.html → assets/config.json).
// S'il n'y a pas encore de configuration, on retombe sur un comportement
// automatique : une image = un fantôme, comportement "wander" par défaut.
async function loadGhosts() {
  let config = { maxGhosts: MAX_GHOSTS, ghosts: [] };
  try {
    config = await (await fetch("assets/config.json")).json();
  } catch (e) {
    console.warn("Impossible de charger la configuration des fantômes :", e);
  }

  const maxGhosts = config.maxGhosts || MAX_GHOSTS;
  PLAYER_SPEED = config.playerSpeed || PLAYER_SPEED;
  const randomCell = () => pickRandomOpenCell({ row: 1, col: 1 });

  if (config.ghosts && config.ghosts.length > 0) {
    fullGhostConfigs = config.ghosts;

    // S'il y a plus de fantômes configurés que la limite autorisée,
    // on en choisit aléatoirement `maxGhosts` parmi la liste.
    const selected =
      config.ghosts.length > maxGhosts
        ? shuffle(config.ghosts).slice(0, maxGhosts)
        : config.ghosts;

    for (const entry of selected) {
      if (!entry.image) continue;
      spawnGhost({ ...entry, cell: randomCell() });
    }
    return;
  }

  // Repli : pas de configuration -> une image du dossier = un fantôme.
  let files = [];
  try {
    files = await (await fetch("assets/ghosts.json")).json();
  } catch (e) {
    console.warn("Impossible de charger la liste des fantômes :", e);
  }

  if (files.length === 0) {
    console.info("Aucune image dans assets/ghosts — dépose des images pour voir des fantômes.");
    return;
  }

  const selected = files.length > maxGhosts ? shuffle(files).slice(0, maxGhosts) : files;
  for (const image of selected) {
    spawnGhost({ image, behavior: "chase", cell: randomCell() });
  }
}

/* =========================================================
   SONS — joués quand un fantôme s'approche du joueur
   ========================================================= */
let soundFiles = [];

async function loadSounds() {
  try {
    const res = await fetch("assets/sounds.json");
    soundFiles = await res.json();
  } catch (e) {
    console.warn("Impossible de charger la liste des sons :", e);
  }

  if (soundFiles.length === 0) {
    console.info("Aucun son dans assets/sounds — dépose un son pour l'entendre approcher.");
  }
}

function updateGhosts(delta) {
  for (const ghost of ghosts) {
    // Étoilé : poursuite plein-map forcée, quel que soit son comportement normal.
    const behavior =
      ghost.starred || ghost.starPending
        ? ghostBehaviors.chase
        : ghostBehaviors[ghost.behavior] || ghostBehaviors.chase;
    behavior(ghost, delta);

    const dist = ghost.sprite.position.distanceTo(camera.position);
    const isNear =
      dist < ghost.detectRadius &&
      hasLineOfSight(camera.position.x, camera.position.z, ghost.sprite.position.x, ghost.sprite.position.z);

    // Recalculé chaque frame à partir de l'état réel de la lecture
    // (plutôt que d'un simple "front montant") pour être sûr que le son
    // s'arrête bien dès qu'on s'éloigne, même en cas de frame ratée.
    if (ghost.audio) {
      if (isNear) {
        if (ghost.audio.paused) playRandomGhostSound(ghost);
        // plus fort quand le fantôme est tout proche, borné par son volume réglé dans l'éditeur
        const proximity = Math.max(0.25, Math.min(1, 1 - dist / ghost.detectRadius));
        ghost.audio.volume = proximity * ghost.volume;
      } else if (!ghost.audio.paused) {
        ghost.audio.pause();
      }
    }
    ghost.isNear = isNear;

    if (dist < ghostContactRadius(ghost)) {
      takeDamage(ghost.damage * delta, ghost);
    }
  }

  if (ghosts.length > 0) hadGhosts = true;
  if (finalWaveStarted && ghosts.length === 0) {
    triggerVictory();
    return;
  }
  if (!allGhostsDefeated && hadGhosts && ghosts.length === 0) {
    allGhostsDefeated = true;
    startDialog(
      ["Bravo, tu as tué tous les fantômes.", "Mais attends... je ne vais pas te laisser gagner comme ça."],
      () => {
        enterBackrooms();
        respawnAllGhosts();
        finalWaveStarted = true;
      }
    );
  }
}

// Renvoie tous les fantômes de la configuration (pas seulement ceux limités
// par maxGhosts) : la dernière vague, après avoir "gagné".
function respawnAllGhosts() {
  for (const entry of fullGhostConfigs) {
    if (!entry.image) continue;
    spawnGhost({ ...entry, cell: pickRandomOpenCell(worldToCell(camera.position.x, camera.position.z)) });
  }
}

/* =========================================================
   ÉTOILE — très rarement, un fantôme au hasard devient 3x plus rapide et
   nous repère quel que soit l'endroit de la map (façon Mario Kart).
   ========================================================= */
let starTimer = 0;

// Phase 1 (silencieuse) : le fantôme fonce déjà droit sur toi (via le
// forçage "chase" dans updateGhosts), mais sans vitesse boostée ni effet —
// juste une approche. Phase 2, une fois le délai écoulé : l'étoile
// s'active pour de vrai (vitesse, couleur, son).
function activateStar(ghost) {
  if (ghost.starred || ghost.starPending) return;
  ghost.starPending = true;
  ghost.starWindup = STAR_WINDUP;
}

// Cases à 3-6 cases du joueur (pas collé, pas à l'autre bout de la map) :
// évite qu'un fantôme loin mette une éternité à arriver, sans pour autant
// apparaître pile devant toi.
function pickNearbyCell(playerCell, minDist, maxDist) {
  const candidates = openCells().filter((c) => {
    const d = cellDist(c, playerCell);
    return d >= minDist && d <= maxDist;
  });
  if (candidates.length === 0) return pickRandomOpenCell(playerCell);
  return candidates[Math.floor(Math.random() * candidates.length)];
}

function reallyActivateStar(ghost) {
  ghost.starPending = false;
  ghost.starred = true;
  ghost.starTimeLeft = STAR_DURATION;
  ghost.normalSpeed = ghost.speed;
  ghost.speed *= STAR_SPEED_MULTIPLIER;

  const cell = pickNearbyCell(worldToCell(camera.position.x, camera.position.z), 3, 6);
  ghost.cell = cell;
  ghost.target = null;
  const { x, z } = cellToWorld(cell.row, cell.col);
  ghost.sprite.position.set(x, GHOST_HEIGHT, z);

  ghost.starAudio = new Audio("assets/arme/star-sound.mp4");
  ghost.starAudio.loop = true; // le son ne dure que 7s, mais l'effet 20 : on le boucle
  ghost.starAudio.play().catch(() => {});
}

function deactivateStar(ghost) {
  ghost.starred = false;
  ghost.speed = ghost.normalSpeed;
  ghost.sprite.material.color.setHex(0xffffff);
  if (ghost.starAudio) ghost.starAudio.pause();
}

function updateStarPowerup(delta) {
  starTimer += delta;
  if (starTimer >= STAR_INTERVAL) {
    starTimer = 0;
    // L'étoile n'existe qu'en difficulté "AHHHHHH" (Ctrl+E reste dispo pour tester quand même).
    if (ghosts.length > 0 && DIFFICULTIES[selectedDifficulty].allowStar) {
      activateStar(ghosts[Math.floor(Math.random() * ghosts.length)]);
    }
  }

  for (const ghost of ghosts) {
    if (ghost.starPending) {
      ghost.starWindup -= delta;
      if (ghost.starWindup <= 0) reallyActivateStar(ghost);
      continue;
    }
    if (!ghost.starred) continue;
    ghost.starTimeLeft -= delta;
    ghost.sprite.material.color.setHSL((performance.now() / 300) % 1, 1, 0.5); // arc-en-ciel, façon étoile
    if (ghost.starTimeLeft <= 0) deactivateStar(ghost);
  }
}

// Ctrl+E : déclenche une étoile immédiatement (raccourci de test), sans
// attendre le minuteur normal — et le remet à zéro pour éviter un cumul.
window.addEventListener("keydown", (e) => {
  if (e.ctrlKey && e.code === "KeyE") {
    e.preventDefault();
    if (ghosts.length > 0) {
      starTimer = 0;
      activateStar(ghosts[Math.floor(Math.random() * ghosts.length)]);
    }
  }
});

/* =========================================================
   VIE DU JOUEUR
   ========================================================= */
let health = MAX_HEALTH;
let maxHealth = MAX_HEALTH;
let gameOver = false;

const healthFill = document.getElementById("health-fill");
const deathOverlay = document.getElementById("death-overlay");
const jumpscareEl = document.getElementById("jumpscare");
const jumpscareImg = document.getElementById("jumpscare-img");
const screamerSound = new Audio("assets/branding/screamer.mp3");
const JUMPSCARE_DURATION = 1200; // ms avant de basculer sur l'écran "Tu es mort"

function updateHealthBar() {
  healthFill.style.width = `${(health / maxHealth) * 100}%`;
}

function takeDamage(amount, killerGhost) {
  if (gameOver) return;
  health = Math.max(0, health - amount);
  updateHealthBar();
  if (health <= 0) triggerGameOver(killerGhost);
}

function triggerGameOver(killerGhost) {
  gameOver = true;
  controls.unlock();
  pauseGameAudio();

  if (killerGhost) {
    jumpscareImg.src = `assets/ghosts/${encodeURIComponent(killerGhost.image)}`;
    jumpscareEl.classList.remove("hidden");
    screamerSound.currentTime = 0;
    screamerSound.play().catch(() => {});
    setTimeout(() => {
      jumpscareEl.classList.add("hidden");
      deathOverlay.classList.remove("hidden");
    }, JUMPSCARE_DURATION);
  } else {
    deathOverlay.classList.remove("hidden");
  }
}

function triggerVictory() {
  gameOver = true;
  controls.unlock();
  pauseGameAudio();
  document.getElementById("victory-overlay").classList.remove("hidden");
}

document.getElementById("restart-btn").addEventListener("click", () => location.reload());

/* =========================================================
   BOULES VERTES — rendent un peu de vie quand on passe dessus.
   Elles flottent dans les couloirs et réapparaissent ailleurs un peu
   plus tard. On ne les ramasse pas si la vie est déjà pleine.
   ========================================================= */
const HEAL_ORB_COUNT = 6;          // nombre de boules dans le labyrinthe
const HEAL_AMOUNT = 25;            // vie rendue par boule
const HEAL_ORB_RESPAWN = 20;       // secondes avant qu'une boule ramassée réapparaisse
const HEAL_PICKUP_RADIUS = 1.2;    // distance pour la ramasser
const HEAL_ORB_HEIGHT = 0.9;

const healOrbGeometry = new THREE.SphereGeometry(0.22, 16, 12);
const healOrbMaterial = new THREE.MeshBasicMaterial({ color: 0x3dff6e });

// Halo vert autour de la boule (dégradé dessiné dans un petit canvas).
const healGlowTexture = (() => {
  const c = document.createElement("canvas");
  c.width = c.height = 64;
  const ctx = c.getContext("2d");
  const g = ctx.createRadialGradient(32, 32, 0, 32, 32, 32);
  g.addColorStop(0, "rgba(120, 255, 150, 0.9)");
  g.addColorStop(0.4, "rgba(60, 255, 110, 0.35)");
  g.addColorStop(1, "rgba(60, 255, 110, 0)");
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 64, 64);
  return new THREE.CanvasTexture(c);
})();

const healOrbs = [];

function placeHealOrb(orb) {
  const taken = healOrbs.filter((o) => o !== orb && o.group.visible).map((o) => o.cell);
  let cell;
  for (let i = 0; i < 30; i++) {
    cell = pickRandomOpenCell({ row: 1, col: 1 });
    if (!taken.some((t) => sameCell(t, cell))) break;
  }
  orb.cell = cell;
  const { x, z } = cellToWorld(cell.row, cell.col);
  orb.group.position.set(x, HEAL_ORB_HEIGHT, z);
  orb.group.visible = true;
  orb.respawnIn = 0;
}

for (let i = 0; i < HEAL_ORB_COUNT; i++) {
  const group = new THREE.Group();
  group.add(new THREE.Mesh(healOrbGeometry, healOrbMaterial));
  const glow = new THREE.Sprite(
    new THREE.SpriteMaterial({ map: healGlowTexture, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending })
  );
  glow.scale.set(1.3, 1.3, 1);
  group.add(glow);
  scene.add(group);
  const orb = { group, cell: null, respawnIn: 0, phase: Math.random() * Math.PI * 2 };
  healOrbs.push(orb);
  placeHealOrb(orb);
}

const healthBarEl = document.getElementById("health-bar");

function updateHealOrbs(delta) {
  const t = performance.now() / 1000;
  for (const orb of healOrbs) {
    if (!orb.group.visible) {
      orb.respawnIn -= delta;
      if (orb.respawnIn <= 0) placeHealOrb(orb);
      continue;
    }

    orb.group.position.y = HEAL_ORB_HEIGHT + Math.sin(t * 3 + orb.phase) * 0.12; // flotte

    const dist = Math.hypot(orb.group.position.x - playerPos.x, orb.group.position.z - playerPos.z);
    if (dist < HEAL_PICKUP_RADIUS && health < maxHealth) {
      health = Math.min(maxHealth, health + HEAL_AMOUNT);
      updateHealthBar();
      orb.group.visible = false;
      orb.respawnIn = HEAL_ORB_RESPAWN;
      healthBarEl.classList.add("heal");
      setTimeout(() => healthBarEl.classList.remove("heal"), 400);
    }
  }
}
document.getElementById("victory-restart-btn").addEventListener("click", () => location.reload());

/* =========================================================
   DIALOGUE — petites boîtes de texte façon visual novel, avec Entrée
   pour passer à la suite. Met le jeu en pause tant que c'est affiché.
   ========================================================= */
const dialogBoxEl = document.getElementById("dialog-box");
const dialogTextEl = document.getElementById("dialog-text");

let dialogActive = false;
let dialogLines = [];
let dialogCallback = null;

function startDialog(lines, callback) {
  dialogLines = lines.slice();
  dialogCallback = callback;
  dialogActive = true;
  advanceDialog();
}

function advanceDialog() {
  if (dialogLines.length === 0) {
    dialogActive = false;
    dialogBoxEl.classList.add("hidden");
    const cb = dialogCallback;
    dialogCallback = null;
    if (cb) cb();
    return;
  }
  dialogTextEl.textContent = dialogLines.shift();
  dialogBoxEl.classList.remove("hidden");
}

window.addEventListener("keydown", (e) => {
  if (dialogActive && e.code === "Enter") advanceDialog();
});

/* =========================================================
   BOUCLE PRINCIPALE
   ========================================================= */
const clock = new THREE.Clock();

function animate() {
  requestAnimationFrame(animate);
  const delta = Math.min(clock.getDelta(), 0.1);

  // En pause dès qu'on n'est pas verrouillé en jeu (menu ouvert, Échap...)
  // ou que la partie est terminée : plus aucun fantôme, minuteur ou arme
  // n'avance tant qu'on est dans un menu.
  if (!gameOver && !dialogActive && controls.isLocked) {
    updatePlayer(delta);
    updateGhosts(delta);
    updateWeapon(delta);
    updateGrenades(delta);
    updateExplosionVideos();
    updateScreenShake(delta);
    updateStarPowerup(delta);
    updateHealOrbs(delta);

    if (cornerPressCount > 0) {
      cornerPressTimer -= delta;
      if (cornerPressTimer <= 0) cornerPressCount = 0;
    }
  }

  // Seul endroit qui écrit camera.position : position logique (collisions)
  // + décalage cosmétique du tremblement, recomposés à chaque frame.
  camera.position.set(playerPos.x + shakeOffset.x, playerPos.y + shakeOffset.y, playerPos.z + shakeOffset.z);

  renderer.render(scene, camera);
}

// Les sons doivent être connus avant de créer les fantômes (pour pouvoir
// leur attribuer un son aléatoire dédié quand aucun n'est choisi) — les
// fantômes eux, ne sont créés qu'au premier clic sur "Jouer" (voir plus
// haut), une fois la difficulté choisie.
(async () => {
  await loadSounds();
  animate();
})();
