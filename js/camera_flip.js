// Botón "Voltear cámara".
//
//   Modo AR   (cámara trasera)  -> PARALLAX: marcador + escena AR (MindAR).
//   Modo cara (cámara frontal)  -> DELIRIUM: filtro facial (MediaPipe).
//
// Al pulsar el botón se detiene un modo (liberando su cámara) y se arranca el otro.
// El filtro de DELIRIUM se carga bajo demanda: no pesa nada hasta que se voltea.

const FACE_SCENE = 'delirium.json';

export function setupCameraFlip({ button, arContainer, getArController, debug = false }) {

	const faceContainer = document.getElementById('delirium-app');
	const faceVideo = document.getElementById('video-renderer');
	const faceCanvas = document.getElementById('canvas-renderer');
	const status = document.getElementById('flip-status');

	let mode = 'ar';       // 'ar' | 'face'
	let busy = false;
	let faceFilter = null;
	let statusTimer = null;

	function showStatus(text, { autoHide = 0 } = {}) {
		clearTimeout(statusTimer);
		status.textContent = text;
		status.classList.add('visible');
		if (autoHide) statusTimer = setTimeout(hideStatus, autoHide);
	}

	function hideStatus() {
		clearTimeout(statusTimer);
		status.classList.remove('visible');
	}

	function setBusy(value) {
		busy = value;
		button.disabled = value;
		button.classList.toggle('busy', value);
	}

	// El video AR "coctel" suena aunque el marcador ya no se vea: avisa a cada target
	// de que se perdió (pausa y reinicia el video) antes de apagar la cámara trasera.
	function notifyTargetsLost(ar) {
		for (const target of ar.threePlayer?.imageTargets ?? []) {
			try { target.onLost?.call(target); } catch (e) { console.warn(e); }
		}
	}

	async function startAR() {
		arContainer.style.display = '';
		await getArController().start();
		mode = 'ar';
	}

	async function startFace() {

		// DELIRIUM sobrescribe window.player; se restaura el de PARALLAX después.
		const previousPlayer = window.player;

		faceContainer.classList.add('active'); // visible antes de medirlo (three.js lo necesita)

		try {
			const { startFaceFilter } = await import('./delirium/mediapipe/mediapipe_controller.js');
			faceFilter = await startFaceFilter(FACE_SCENE, {
				showGui: debug,
				container: faceContainer,
				video: faceVideo,
				canvas: faceCanvas,
			});
			mode = 'face';
			// Intenta activar el sonido ya (si el navegador lo exige, se activa al primer toque).
			faceFilter.player.unlockAudio?.().catch(() => {});
		} catch (error) {
			faceContainer.classList.remove('active');
			throw error;
		} finally {
			window.player = previousPlayer;
		}
	}

	function stopFace() {
		faceFilter?.stop();
		faceFilter = null;
		faceContainer.classList.remove('active');
	}

	async function flip() {

		if (busy) return;
		setBusy(true);

		const ar = getArController();

		try {

			if (mode === 'face') {

				// Cara -> AR
				showStatus('Volviendo al AR…');
				stopFace();                         // libera la cámara frontal
				await startAR();

			} else if (!ar.started) {

				// Estamos en AR pero la cámara no arrancó (p. ej. permiso denegado): reintentar.
				showStatus('Volviendo al AR…');
				await startAR();

			} else {

				// AR -> Cara
				showStatus('Cargando filtro…');
				notifyTargetsLost(ar);
				ar.stop();                          // libera la cámara trasera
				arContainer.style.display = 'none';
				try {
					await startFace();
				} catch (error) {
					console.error('No se pudo iniciar el filtro facial:', error);
					await startAR();                // vuelve a donde estaba
					throw error;
				}

			}

			hideStatus();

		} catch (error) {
			console.error('Error al voltear la cámara:', error);
			showStatus('No se pudo cambiar de cámara. Revisa los permisos e inténtalo de nuevo.', { autoHide: 4500 });
		} finally {
			setBusy(false);
		}
	}

	button.addEventListener('click', flip);

	return {
		show() { button.hidden = false; },
		get mode() { return mode; },
	};
}
