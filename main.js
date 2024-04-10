import * as d3 from 'd3';
import { feature } from 'topojson-client';
import { geoContains } from 'd3-geo';

const width = window.innerWidth;
const height = window.innerHeight;
const DEPTH = 10;  // 10 --> approx. -100 meters
const FACES = [0, 1, 2];
const PARTICLES = 20000;
const RANDOM_SPAWN = true;
// const MAX_MAGNITUDE = 0.5032521786989669;
const MAX_MAGNITUDE = 0.05;
const FRAME_RATE = 40;  // Milliseconds between frames
const LINE_WIDTH = 1.0;

var COLOR_LAND = "transparent";
var COLOR_SEA = "transparent";
var COLOR_FADE = "transparent";

// Function to apply dark or light mode styles
function applyColorSchemePreference(isDarkMode) {
    if (isDarkMode) {
        // Apply dark mode styles
        document.body.classList.add('dark-mode');
        COLOR_LAND = "rgba(32,32,32,1)";
        COLOR_SEA = "rgba(64,64,64,1)";
        COLOR_FADE = 'rgba(64,64,64, 0.05)';
    } else {
        // Apply light mode styles and remove dark mode styles
        document.body.classList.remove('dark-mode');
        COLOR_LAND = "tan";
        COLOR_SEA = "rgb(70,130,180)";
        COLOR_FADE = 'rgba(70,130,180, 0.05)';
    }

    // Update the SVG paths for land with the new color
    svg.selectAll("path")
        .attr("fill", COLOR_LAND);

    // Update the canvas background color
    context.fillStyle = COLOR_SEA;
    context.fillRect(0, 0, width, height);
}

// Check for dark mode preference at the time of script execution
const prefersDarkScheme = window.matchMedia('(prefers-color-scheme: dark)');

// Listen for changes in the color scheme preference,
// and apply styles dynamically if the preference changes
prefersDarkScheme.addEventListener('change', (e) => {
  applyColorSchemePreference(e.matches);
});

// Globe SVG
const svg = d3.select("body").append("svg")
    .attr("width", width)
    .attr("height", height);

// Canvas for Particles
const canvas = d3.select("body").append("canvas")
    .attr("width", width)
    .attr("height", height)
    .node();
const context = canvas.getContext("2d");

// Projection and Path
const projection = d3.geoOrthographic()
    .scale(width)
    .translate([width / 2, height / 2])
    .rotate([20, -75]);
    // .rotate([0, -90]);
const path = d3.geoPath().projection(projection);

// Load and display the map
d3.json('land-50m.json').then(topology => {
    svg.selectAll("path")
        .data(feature(topology, topology.objects.land).features)
        .enter().append("path")
        .attr("d", path);
    document.body.appendChild(svg.node());
    applyColorSchemePreference(prefersDarkScheme.matches);
});

let data; // Hold ocean current data
let visibilityMask; // Visibility mask for determining visible particles

// Load data
async function loadData(jsonFilePath) {
    try {
        const response = await fetch(jsonFilePath);
        if (!response.ok) {
            throw new Error(`HTTP error! status: ${response.status}`);
        }
        data = await response.json(); // Directly assign to global variable
        // console.log(data);
    } catch (error) {
        console.error("Could not load the JSON data:", error);
    }
}

function createVisibilityMask() {
    const maskCanvas = document.createElement("canvas");
    maskCanvas.width = width;
    maskCanvas.height = height;
    const maskCtx = maskCanvas.getContext("2d");

    // Fill the canvas with black (invisible)
    maskCtx.fillStyle = "black";
    maskCtx.fillRect(0, 0, width, height);

    // Draw the visible hemisphere in white (visible)
    maskCtx.fillStyle = "white";
    maskCtx.beginPath();
    const pathGenerator = d3.geoPath().projection(projection).context(maskCtx);
    pathGenerator({type: "Sphere"});
    maskCtx.closePath();
    maskCtx.fill();

    return maskCanvas;
}

function isVisibleOnMask(x, y) {
    if (!x || !y) return false;
    const pixelData = visibilityMask.getContext('2d').getImageData(x, y, 1, 1).data;
    return pixelData[0] === 255; // Check if the pixel is white
}

function getVectorAtGridPoint(face, i, j) {
    if (!data) return [null, null];

    i = Math.round(i);
    j = Math.round(j);

    if (i < 0 || i >= data.metadata.gridShape[2] ||
        j < 0 || j >= data.metadata.gridShape[1]) return null;

    return [
        data.data.U[DEPTH][face][j][i],
        data.data.V[DEPTH][face][j][i]
    ];
}

function normalizeLongitude(lon) {
    while (lon < -180) lon += 360;
    while (lon > 180) lon -= 360;
    return lon;
}

function interpolateLongitude(lon1, lon2, fraction) {
    lon1 = normalizeLongitude(lon1);
    lon2 = normalizeLongitude(lon2);
    
    if (Math.abs(lon1 - lon2) > 180) {
        if (lon1 > lon2) lon1 -= 360;
        else lon2 -= 360;
    }
    
    let interpolatedLon = lon1 + (lon2 - lon1) * fraction;
    return normalizeLongitude(interpolatedLon);
}

function bilinearInterpolation(face, x, y, values, isLongitude = false) {
    const x1 = Math.floor(x);
    const x2 = Math.ceil(x);
    const y1 = Math.floor(y);
    const y2 = Math.ceil(y);

    if (x2 === x1 || y2 === y1) { // Avoid division by zero
        return values[face][y1][x1];
    }

    const f11 = values[face][y1][x1];
    const f12 = values[face][y1][x2];
    const f21 = values[face][y2][x1];
    const f22 = values[face][y2][x2];

    const r1 = isLongitude ? interpolateLongitude(f11, f12, (x - x1) / (x2 - x1)) : (((x2 - x) / (x2 - x1)) * f11) + (((x - x1) / (x2 - x1)) * f12);
    const r2 = isLongitude ? interpolateLongitude(f21, f22, (x - x1) / (x2 - x1)) : (((x2 - x) / (x2 - x1)) * f21) + (((x - x1) / (x2 - x1)) * f22);

    return isLongitude ? interpolateLongitude(r1, r2, (y - y1) / (y2 - y1)) : (((y2 - y) / (y2 - y1)) * r1) + (((y - y1) / (y2 - y1)) * r2);
}

function gridPointToLonLat(face, i, j, interpolation = true) {
    if (!data || !data.grid || !data.grid.lon || !data.grid.lat) {
        console.error("Data is not properly loaded or structured.");
        return { lon: null, lat: null };
    }

    const maxI = data.metadata.gridShape[2] - 1;
    const maxJ = data.metadata.gridShape[1] - 1;
    const boundedI = Math.min(Math.max(i, 0), maxI);
    const boundedJ = Math.min(Math.max(j, 0), maxJ);

    // Direct value access without interpolation
    if (!interpolation) {
        const directLon = data.grid.lon[face][Math.round(boundedJ)][Math.round(boundedI)];
        const directLat = data.grid.lat[face][Math.round(boundedJ)][Math.round(boundedI)];
        return [directLon, directLat];
    }

    // Apply bilinear interpolation
    const lon = bilinearInterpolation(face, boundedI, boundedJ, data.grid.lon, true); // true for longitude
    const lat = bilinearInterpolation(face, boundedI, boundedJ, data.grid.lat);

    return [lon, lat];
}

// Now using grid space for particle storage and movement
let particles = []; // Define particles array globally
let bins = [
    {alpha: 0.1, particles: []},
    {alpha: 0.2, particles: []},
    {alpha: 0.3, particles: []},
    {alpha: 0.4, particles: []},
];

function resetParticle(p, gridSize = 90) {
    if (RANDOM_SPAWN) {
        p.i = Math.random() * (gridSize - 1);
        p.j = Math.random() * (gridSize - 1);
    } else {
        p.face = p.origin[0];
        p.i = p.origin[1];
        p.j = p.origin[2];
    }
    p.u = 0;
    p.v = 0;
    p.m = 0;
    [p.x, p.y] = projection(gridPointToLonLat(p.face, p.i, p.j));
    [p.xt, p.yt] = [p.x, p.y];
    p.lifespan = Math.random();
}

function updateParticles() {
    particles.forEach(p => {
        p.lifespan -= 0.01;
        const vector = getVectorAtGridPoint(p.face, p.i, p.j);
        if (!vector || p.lifespan <= 0) {
            resetParticle(p);
        } else {
            [p.x, p.y] = projection(gridPointToLonLat(p.face, p.i, p.j));
            [p.u, p.v] = vector;
            p.i += p.u;
            p.j += p.v;
            p.m = Math.sqrt(p.u**2 + p.v**2) / MAX_MAGNITUDE;
            if (p.m > 0.4) {
                bins[3].particles.push(p);
            } else if ((p.m > 0.3)) {
                bins[2].particles.push(p);
            } else if ((p.m > 0.2)) {
                bins[1].particles.push(p);
            } else if ((p.m > 0.1)) {
                bins[0].particles.push(p);
            }
            [p.xt, p.yt] = projection(gridPointToLonLat(p.face, p.i, p.j));
        }
    });
}

function animate() {
    // context.fillStyle = `rgba(128, 128, 128, 0.05)`;
    // context.fillStyle = `rgba(255, 255, 255, 0.01)`;
    context.fillStyle = COLOR_FADE;
    context.fillRect(0, 0, width, height);
    context.lineWidth = LINE_WIDTH;

    updateParticles();

    bins.forEach(b => {
        context.strokeStyle = `rgba(255, 255, 255, ${b.alpha})`;
        b.particles.forEach(p => {
            context.beginPath();
            context.moveTo(p.x, p.y);
            context.lineTo(p.xt, p.yt);
            context.stroke();
            p.x = p.xt;
            p.y = p.yt;
        });
    });

    bins = [
        {alpha: 0.1, particles: []},
        {alpha: 0.2, particles: []},
        {alpha: 0.3, particles: []},
        {alpha: 0.8, particles: []},
    ];

    requestAnimationFrame(() => {
        setTimeout(animate, FRAME_RATE);
    });
}

function init() {
    context.fillStyle = COLOR_SEA;
    context.fillRect(0, 0, width, height);
    visibilityMask = createVisibilityMask(); // Initialize visibility mask

    const gridSize = 90; // Assuming a grid of 90x90 for simplicity
    particles = []; // Reset particles array

    if (RANDOM_SPAWN) {
        for (const face of FACES) {
            for (var i = 0; i < PARTICLES / FACES.length; i++) {
                particles.push({
                    face: face,
                    i: Math.random() * gridSize,
                    j: Math.random() * gridSize,
                    u: 0, v: 0, m: 0,
                    x: 0, y: 0,
                    lifespan: Math.random()
                });
            }
        }
    } else {
        // Create particles evenly distributed across the grid
        const numParticlesPerRow = Math.sqrt(PARTICLES / FACES.length);
        const spacing = gridSize / numParticlesPerRow;
        for (const face of FACES) {
            for (let i = 0; i < numParticlesPerRow; i++) {
                for (let j = 0; j < numParticlesPerRow; j++) {
                    particles.push({
                        origin: [face, i * spacing, j * spacing],
                        face: face,
                        i: i * spacing,
                        j: j * spacing,
                        u: 0, v: 0, m: 0,
                        x: 0, y: 0,
                        lifespan: Math.random(),
                    });
                }
            }
        }
    }

    animate(); // Start the animation loop
}

// Load data and initiate the visualization
loadData('ocean_currents_data.json').then(ocean_data => {
    init(); // Initialize visualization after confirming data structure
});
