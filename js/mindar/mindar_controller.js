import * as THREE from 'three';
import { MindARThree } from 'mindar-image-three';

class MindARController {

    constructor(container, threePlayer, debug = false) {
        this.container = container;
        this.threePlayer = threePlayer;
        this.debug = debug;
        this.isMobile = /Android|iPhone|iPod|iPad/i.test(navigator.userAgent);

        this.imageTargetSrc = 'assets/marker/targets.mind';

        this.mindar = null;
        this.anchors = [];
        this.started = false;

        this.listeners = {
            start: [],
            found: [],
            lost: [],
            update: [],
        };

        this.clickHandlerBound = false;
    }

    addListener(type, callback) { this.listeners[type].push(callback); }

    dispatch(type, event) {
        for (const listener of this.listeners[type]) {
            listener(event);
        }
    }

    async start() {

        if (this.started) return;

        // Limpia restos de un intento anterior (p.ej. un <video> huérfano).
        if (this.mindar) { this.stop(); }
        this.container.replaceChildren();

        const player = this.threePlayer;
        const imageTargets = player?.imageTargets;

        if (!imageTargets || !imageTargets.length) {
            throw new Error('player.imageTargets está vacío. Asegurate de que los scripts de la escena se ejecutaron.');
        }

        this.mindar = new MindARThree({
            container: this.container,
            imageTargetSrc: this.imageTargetSrc,
            // Suavizado del seguimiento (One Euro Filter). Menos filterMinCF = menos temblor
            // cuando el celular está casi quieto (default de MindAR: 0.001). Si notas que el
            // contenido "se arrastra" al mover rápido, sube filterBeta; si aún tiembla, baja
            // filterMinCF (p. ej. 0.00005).
            // OJO: con filterMinCF muy bajo (0.0001) el filtro tarda >1 s en converger:
            // si la primera pose detectada es imprecisa, el contenido aparece lejos del
            // marcador y se va "arrastrando" hacia él. Por eso se usa un valor más alto
            // y además se descartan más frames de calentamiento y se hace "snap" (ver
            // installSnapGuard).
            filterMinCF: 0.0002,
            filterBeta: 1000,
            warmupTolerance: 8,
            missTolerance: 5,
            uiLoading: 'no',
            uiScanning: 'no',
            uiError: 'yes',
        });

        const { scene, camera, renderer } = this.mindar;

        // Anchora el contenido AR de cada ImageTarget sobre el target.
        renderer.setPixelRatio(window.devicePixelRatio);
        renderer.setClearColor(0x000000, 0);

        for (let i = 0; i < imageTargets.length; i++) {
            const it = imageTargets[i];
            const anchor = this.mindar.addAnchor(i);

            const content = it.arContent;
            if (content) {
                // El contenido se diseñó en el editor con el marcador en el suelo
                // (el "up" del editor es +Y). En MindAR el plano del target es XY
                // y +Z apunta hacia la cámara, así que rotamos +90° en X para que
                // el contenido quede en pie sobre el marcador. 1 unidad MindAR =
                // ancho del marcador (= 1.65 en el editor), por eso 1/1.65 ≈ 0.6.
                content.scale.setScalar(0.6);
                content.rotation.set(THREE.MathUtils.degToRad(90), 0, 0);

                anchor.group.add(content);
            }

            if (this.debug) {
                this.addMarkerDebugHelpers(anchor.group);
            }

            anchor.onTargetFound = () => {
                console.log(`MindARController: target detectado ${i}`);
                if (it.onFound) it.onFound.call(it);
                if (content) content.visible = true;
                this.dispatch('found', it);
            };

            anchor.onTargetLost = () => {
                console.log(`MindARController: target perdido ${i}`);
                if (it.onLost) it.onLost.call(it);
                if (content) content.visible = false;
                this.dispatch('lost', it);
            };

            this.anchors.push(anchor);
        }

        this.copyEnvironment(scene, player);
        this.copyLights(scene, player);
        this.copyRendererSettings(renderer, player);

        // El player sigue corriendo (events update/audio) pero deja de pintar.
        if (player?.setRenderEnabled) player.setRenderEnabled(false);

        this.bindClickEvents();

        try {
            await this.mindar.start();
        } catch (e) {
            this.mindar = null;
            this.started = false;
            const detail = (e && e.message) ? `: ${e.message}` : '. Comprobá que la cámara esté disponible y permitas el acceso';
            throw new Error(`No se pudo iniciar la cámara AR${detail}`);
        }

        this.installSnapGuard();

        renderer.setAnimationLoop(() => {
            this.dispatch('update', {});
            renderer.render(scene, camera);
        });

        this.started = true;
        this.dispatch('start', {});
    }

    // Evita que el suavizado "arrastre" el contenido desde una pose vieja o imprecisa:
    // si la pose cruda salta más de SNAP_DISTANCE respecto a la última filtrada
    // (el marcador reapareció en otro sitio, o la primera detección era mala),
    // se reinicia el filtro y el contenido salta directo a la pose correcta.
    installSnapGuard() {
        const SNAP_DISTANCE = 0.3; // en unidades de MindAR (1 = ancho del marcador)
        const states = this.mindar?.controller?.trackingStates ?? [];
        for (const state of states) {
            const filter = state.filter;
            if (!filter || filter.__snapGuard) continue;
            const original = filter.filter.bind(filter);
            filter.filter = (t, x) => {
                const prev = filter.initialized ? filter.xPrev : null;
                if (prev) {
                    const dx = x[12] - prev[12], dy = x[13] - prev[13], dz = x[14] - prev[14];
                    if (Math.hypot(dx, dy, dz) > SNAP_DISTANCE) filter.reset();
                }
                return original(t, x);
            };
            filter.__snapGuard = true;
        }
    }

    stop() {
        if (!this.mindar) return;
        const renderer = this.mindar.renderer;
        if (renderer?.setAnimationLoop) {
            renderer.setAnimationLoop(null);
        }
        this.mindar.stop();
        // Libera el contexto WebGL: al voltear la cámara se crea uno nuevo en cada start().
        renderer?.dispose?.();
        renderer?.forceContextLoss?.();
        this.mindar = null;
        this.started = false;
        this.anchors = [];
    }

    switchCamera() {
        this.mindar?.switchCamera();
    }

    copyEnvironment(scene, player) {
        const appScene = player?.scene;
        if (!appScene) return;

        if (appScene.environment) {
            scene.environment = appScene.environment;
        }
        if (appScene.environmentIntensity !== undefined) {
            scene.environmentIntensity = appScene.environmentIntensity;
        }
        if (appScene.environmentRotation) {
            scene.environmentRotation.copy(appScene.environmentRotation);
        }
    }

    copyLights(scene, player) {
        const appScene = player?.scene;
        if (!appScene) return;

        appScene.traverse((obj) => {
            if (obj.isLight && obj !== appScene) {
                scene.add(obj.clone());
            }
        });
    }

    copyRendererSettings(renderer, player) {
        const appRenderer = player?.renderer;
        if (!appRenderer || !renderer) return;

        renderer.toneMapping = appRenderer.toneMapping;
        renderer.toneMappingExposure = appRenderer.toneMappingExposure;
        renderer.shadowMap.enabled = appRenderer.shadowMap?.enabled === true && !this.isMobile;
        renderer.shadowMap.type = appRenderer.shadowMap?.type ?? THREE.PCFShadowMap;
    }

    bindClickEvents() {
        if (this.clickHandlerBound) return;
        this.clickHandlerBound = true;

        if (window.PointerEvent) {
            document.addEventListener('pointerdown', (ev) => this.onArClick(ev));
        } else {
            document.addEventListener('touchstart', (ev) => {
                const touch = ev.changedTouches?.[0];
                if (touch) this.onArClick(touch);
            });
            document.addEventListener('click', (ev) => this.onArClick(ev));
        }
    }

    onArClick(ev) {
        const mindar = this.mindar;
        if (!mindar) return;

        const { scene, camera, renderer } = mindar;
        const canvas = renderer?.domElement;

        const rect = canvas.getBoundingClientRect();
        const mouse = new THREE.Vector2(
            ((ev.clientX - rect.left) / rect.width) * 2 - 1,
            -((ev.clientY - rect.top) / rect.height) * 2 + 1
        );

        const raycaster = new THREE.Raycaster();
        raycaster.setFromCamera(mouse, camera);

        const hits = raycaster.intersectObjects(scene.children, true);
        for (const hit of hits) {
            let obj = hit.object;
            while (obj) {
                if (obj.onClick && typeof obj.onClick === 'function' && this.objIsActive(obj)) {
                    obj.onClick();
                    return;
                }
                obj = obj.parent;
            }
        }
    }

    objIsActive(obj) {
        if (obj.visible === false) return false;
        let active = true;
        obj.traverseAncestors((ancestor) => {
            if (ancestor.visible === false) active = false;
        });
        return active;
    }

    addMarkerDebugHelpers(root) {
        const planeSize = 0.5;
        const planeGeometry = new THREE.PlaneGeometry(planeSize, planeSize, 1, 1);
        const planeMaterial = new THREE.MeshBasicMaterial({
            color: 0x00ffff,
            transparent: true,
            opacity: 0.25,
            side: THREE.DoubleSide,
            depthWrite: false,
        });

        root.add(new THREE.Mesh(planeGeometry, planeMaterial));
        root.add(new THREE.LineSegments(
            new THREE.EdgesGeometry(planeGeometry),
            new THREE.LineBasicMaterial({ color: 0x00ffff })
        ));
        root.add(new THREE.AxesHelper(0.3));
    }

}

export { MindARController };