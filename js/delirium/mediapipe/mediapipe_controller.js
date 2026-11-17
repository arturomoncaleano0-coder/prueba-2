// Arranca un filtro facial: camara + MediaPipe + escena JSON del editor de three.js.
//
// Uso en una pagina HTML:
//   import { startFaceFilter } from "./js/mediapipe/mediapipe_controller.js";
//   startFaceFilter("app.json");
//
// Como se usa la escena:
//   - El objeto llamado "mesh_0" es la mascara: se deforma con la cara.
//   - Todo lo demas (gafas, esferas, luces, ...) sigue la posicion, el giro y el
//     tamaño de la cabeza (ver js/mediapipe/face_mask.js para las unidades).
//   - Los scripts de la escena reciben los eventos faciales (ver js/app.js).
//
// (PARALLAX) Cambios respecto al original de DELIRIUM:
//   - Acepta { container, video, canvas } para no depender de los ids #app, etc.
//   - Devuelve filter.stop(): libera camara, MediaPipe, audio y WebGL para poder
//     volver a la camara trasera (modo AR) sin dejar nada corriendo.

import GUI from "https://cdn.jsdelivr.net/npm/lil-gui@0.20.0/+esm";

import WebCamera from "../webcamera.js";
import ThreePlayer from "../app.js";
import MPFaceTracker from "./mp_face_tracker.js";
import MPFaceRenderer from "./mp_face_renderer.js";
import ThreeFaceRenderer from "./three_face_renderer.js";
import FaceEvents from "./face_events.js";

const MASK_NAME = "mesh_0";

export async function startFaceFilter(scenePath, { showGui = true, container = null, video: videoElement = null, canvas: canvasElement = null } = {}) {

    const app = container ?? document.getElementById("app");
    const video = videoElement ?? document.getElementById("video-renderer");
    const canvas = canvasElement ?? document.getElementById("canvas-renderer");

    // Cada recurso que se crea registra aqui como liberarse. stop() los ejecuta en
    // orden inverso; si el arranque falla a medias, tambien se liberan (p. ej. si el
    // usuario niega el permiso de la camara o falla la carga de la escena).
    const cleanups = [];
    let running = true;
    let frameId = 0;

    const stop = () => {
        running = false;
        cancelAnimationFrame(frameId);
        while (cleanups.length) {
            try { cleanups.pop()(); } catch (error) { console.warn("DELIRIUM: error al liberar recursos", error); }
        }
    };

    try {

    // Camara y seguimiento de la cara
    const webCamera = new WebCamera(video);
    await webCamera.startCamera();
    cleanups.push(() => webCamera.stopCamera());

    const tracker = new MPFaceTracker(video);
    await tracker.init();
    cleanups.push(() => tracker.landmarker?.close());

    const faceEvents = new FaceEvents();

    // Ayudas 2D de MediaPipe (malla, puntos, contornos) sobre el video
    const mpRenderer = new MPFaceRenderer(video, canvas);
    cleanups.push(() => mpRenderer.clear());

    // Escena 3D del editor
    const player = new ThreePlayer(app);
    cleanups.push(() => disposePlayer(player));
    player.face = faceEvents;
    faceEvents.addListener((type, face) => player.dispatch(type, face));
    await player.loadProject(scenePath);

    const faceRenderer = new ThreeFaceRenderer(video, player);
    faceRenderer.alignCamera();

    // La mascara sale del grupo de la escena: se coloca vertice a vertice en la cara.
    // Sus hijos (si alguien los emparento en el editor) se quedan en la escena
    // para que sigan la cabeza como el resto de objetos.
    const mask = player.rootNode.getObjectByName(MASK_NAME);
    if (mask) {
        for (const child of [...mask.children]) mask.parent.attach(child);
        faceRenderer.faceGroup.add(mask);
    } else {
        console.warn(`La escena no tiene un objeto "${MASK_NAME}": no habra mascara facial.`);
    }

    const settings = { headScale: 1 };

    function update() {

        if (!running) return;

        tracker.update();
        faceEvents.update(tracker);

        const landmarks = tracker.getLandmarks();

        mpRenderer.drawMesh(landmarks);
        mpRenderer.drawPoints(landmarks);
        mpRenderer.drawIrises(landmarks);
        mpRenderer.drawContours(landmarks);

        faceRenderer.drawMesh(landmarks);
        faceRenderer.drawConnectors(landmarks);
        faceRenderer.drawContours(landmarks);
        faceRenderer.drawIrises(landmarks);
        faceRenderer.drawPoints(landmarks);
        if (mask) faceRenderer.syncFaceMesh(mask);

        // La escena sigue la cabeza (solo se oculta la mascara si no hay cara).
        const detected = tracker.getFaceCount() > 0;
        player.rootNode.visible = detected;
        if (mask) mask.visible = detected;

        const pose = detected ? faceRenderer.getHeadPose() : null;
        if (pose) {
            player.rootNode.position.copy(pose.position);
            player.rootNode.quaternion.copy(pose.quaternion);
            player.rootNode.scale.setScalar(pose.scale * settings.headScale);
        }

        player.update();
        frameId = requestAnimationFrame(update);

    }

    const onResize = () => {
        mpRenderer.resize();
        player.resize();
        faceRenderer.alignCamera();
    };
    window.addEventListener("resize", onResize);
    cleanups.push(() => window.removeEventListener("resize", onResize));

    if (showGui) {
        const gui = createGui(settings, mpRenderer, faceRenderer);
        cleanups.push(() => gui.destroy());
    }

    update();

    // Para depurar desde la consola del navegador.
    const filter = { webCamera, tracker, faceEvents, mpRenderer, player, faceRenderer, mask, stop };
    window.faceFilter = filter;
    cleanups.push(() => { if (window.faceFilter === filter) window.faceFilter = null; });
    return filter;

    } catch (error) {
        stop();
        throw error;
    }

}

// Libera el player de la escena: scripts (stop), audio, geometrias/texturas y contexto WebGL.
function disposePlayer(player) {

    player.stop();

    // El script "Player" de la escena crea un AudioContext propio.
    player.audioContext?.close?.().catch?.(() => {});

    player.mainScene.traverse((object) => {
        object.geometry?.dispose?.();
        const materials = Array.isArray(object.material) ? object.material : [object.material];
        for (const material of materials) {
            if (!material) continue;
            for (const value of Object.values(material)) {
                if (value?.isTexture) value.dispose();
            }
            material.dispose?.();
        }
    });

    player.renderer.dispose();
    player.renderer.forceContextLoss();
    player.renderer.domElement.remove();

}

function createGui(settings, mpRenderer, faceRenderer) {

    const gui = new GUI({ title: "Controles" });
    gui.close();

    const helpers2D = gui.addFolder("Ayudas 2D (MediaPipe)");
    helpers2D.add(mpRenderer, "showHelpers").name("Mostrar");
    helpers2D.add(mpRenderer, "showMesh").name("Malla");
    helpers2D.add(mpRenderer, "showPoints").name("Puntos");
    helpers2D.add(mpRenderer, "showContours").name("Contornos");
    helpers2D.add(mpRenderer, "showIrises").name("Iris");

    const helpers3D = gui.addFolder("Ayudas 3D (three.js)");
    helpers3D.add(faceRenderer, "showHelpers").name("Mostrar");
    helpers3D.add(faceRenderer, "showMesh").name("Malla");
    helpers3D.add(faceRenderer, "showConnectors").name("Conexiones");
    helpers3D.add(faceRenderer, "showPoints").name("Puntos");
    helpers3D.add(faceRenderer, "showContours").name("Contornos");
    helpers3D.add(faceRenderer, "showIrises").name("Iris");

    const scene = gui.addFolder("Escena");
    scene.add(settings, "headScale", 0.1, 5).name("Escala de la cabeza");
    scene.add(faceRenderer, "exportAndDownloadMesh").name("Exportar malla capturada (.glb)");

    return gui;

}
