export function bindFollowKeys(setFollow, resetCamera) {
    let following = true;
    setFollow(following);

    window.addEventListener('keydown', (e) => {
        if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;
        if (e.key === 'f' || e.key === 'F') {
            following = !following;
            setFollow(following);
        }
        if (e.key === 'r' || e.key === 'R') resetCamera();
    });
}

export function bindActorKeys(duckPolicy, loop, handoff) {
    window.addEventListener('keydown', (e) => {
        if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;

        const setCmd = (vx, vy, wz) => {
            duckPolicy?.setVel?.(vx, vy, wz);
            loop?.setCmd?.(vx, vy, wz);
        };

        if (e.key === '1') setCmd(0, 0, 0);
        if (e.key === '2') setCmd(0.15, 0, 0);
        if (e.key === '3') setCmd(0.25, 0, 0);
        if (e.key === 'q' || e.key === 'Q') setCmd(0, 0, 1);
        if (e.key === 'e' || e.key === 'E') setCmd(0, 0, -1);
        if (e.key === 'b' || e.key === 'B') handoff?.forceBrain?.();
        if (e.key === 'n' || e.key === 'N') handoff?.forceDemo?.();
        if (e.key === 'p' || e.key === 'P') {
            if (handoff?.isPolicyActor?.()) handoff.forceBrain();
            else handoff?.forceDemo?.();
        }
    });
}