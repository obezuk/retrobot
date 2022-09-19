import 'dotenv/config';
import * as fs from 'fs';
import * as tmp from 'tmp';
import * as path from 'path';
import Piscina from 'piscina';
import encode from 'image-encode';
import { crc32 } from 'hash-wasm';
import * as shelljs from 'shelljs';
import { performance } from 'perf_hooks';
import { values, first, size, last, isEqual } from 'lodash';

import { arraysEqual, InputState, isDirection, rgb565toRaw } from './util';
import { emulateParallel } from './workerInterface';
import { Frame } from './worker';

import sharp from 'sharp';
import * as GIF from 'sharp-gif2';

tmp.setGracefulCleanup();

const RECORDING_FRAMERATE = 30;

interface AutoplayInputState extends InputState {
    autoplay?: boolean
    data?: any
}

const TEST_INPUTS: AutoplayInputState[] = [
    { A: true, autoplay: true },
    { B: true, autoplay: false },
    { DOWN: true, autoplay: false },
    { UP: true, autoplay: false },
    { LEFT: true, autoplay: false },
    { RIGHT: true, autoplay: false }
];

export enum CoreType {
    NES = 'nes',
    SNES = 'snes',
    GB = 'gb',
    GBA = 'gba'
}

export const emulate = async (pool: Piscina, coreType: CoreType, game: Uint8Array, state: Uint8Array, playerInputs: InputState[]) => {
    let data = { coreType, game, state, frames: [], av_info: {} as any };

    const startEmulation = performance.now();

    for (let i = 0; i < playerInputs.length; i++) {
        const prev = playerInputs[i - 1];
        const current = playerInputs[i];
        const next = playerInputs[i + 1];

        if (isDirection(current)) {
            if (isEqual(current, next) || isEqual(current, prev)) {
                data = await emulateParallel(pool, data, { input: current, duration: 20 });
            } else {
                data = await emulateParallel(pool, data, { input: current, duration: 8 });
                data = await emulateParallel(pool, data, { input: {}, duration: 8 });
            }
        } else {
            data = await emulateParallel(pool, data, { input: current, duration: 4 });
            data = await emulateParallel(pool, data, { input: {}, duration: 16 });
        }
    }

    const endFrameCount = data.frames.length + 30 * 60;

    test: while (data.frames.length < endFrameCount) {
        const possibilities: { [hash: string]: AutoplayInputState } = {};

        const controlResultTask = emulateParallel(pool, data, { input: {}, duration: 20 })
        const controlHashTask = controlResultTask.then(result => crc32(last(result.frames).buffer));

        await Promise.all(TEST_INPUTS.map(testInput => async () => {
            if (size(possibilities) > 1) {
                return;
            }

            const testInputData = await emulateParallel(pool, data, { input: testInput, duration: 4 });
            const testIdleData = await emulateParallel(pool, testInputData, { input: {}, duration: 16 });

            const testHash = await crc32(last(testIdleData.frames).buffer);

            if ((await controlHashTask) != testHash) {
                if (!possibilities[testHash] || (possibilities[testHash] && testInput.autoplay)) {
                    possibilities[testHash] = {
                        ...testInput,
                        data: testIdleData
                    };
                }
            }
        }).map(task => task()));

        if (size(possibilities) > 1) {
            break test;
        }

        const possibleAutoplay = first(values(possibilities));

        if (size(possibilities) == 1 && possibleAutoplay.autoplay) {
            data = possibleAutoplay.data;
        } else {
            data = await controlResultTask;
        }

        data = await emulateParallel(pool, data, { input: {}, duration: 32 });
    }

    data = await emulateParallel(pool, data, { input: {}, duration: 30 });

    const endEmulation = performance.now();
    console.log(`Emulation: ${endEmulation - startEmulation}`);

    const startFrames = performance.now();

    const { frames } = data;

    const importantFrames: (Frame & { renderTime: number })[] = [];
    let lastFrame: Frame;
    let durationSinceFrame = 0;
    for (let i = 0; i < frames.length; i++) {
        if (i == 0 || durationSinceFrame >= (60 / RECORDING_FRAMERATE)) {
            const currentFrame = frames[i];

            if (!arraysEqual(currentFrame.buffer, lastFrame?.buffer)) {
                importantFrames.push({
                    ...currentFrame,
                    renderTime: i
                })

                lastFrame = currentFrame;
                durationSinceFrame = 0;
            }
        } else {
            durationSinceFrame++;
        }
    }

    if (!arraysEqual(last(importantFrames).buffer, lastFrame.buffer)) {
        importantFrames.push({
            ...last(importantFrames),
            renderTime: frames.length
        })
    }

    const { width, height } = last(importantFrames);

    var tmpGif = GIF.createGif({
        'width': width * 2,
        'height': height * 2,
        'delay' : 1,
        'repeat' : 1
    })

    for (var f in importantFrames) {
        var buffer = Buffer.from(encode(rgb565toRaw(importantFrames[f]), [width, height],'png'));
        var sharpInstance = sharp(buffer);
        tmpGif.addFrame(sharpInstance)
    }

    const endFrames = performance.now();
    console.log(`Exporting frames: ${endFrames - startFrames}`);

    const startEncode = performance.now();

    var tmpGifBuffer = Buffer.from(await tmpGif.toBuffer())

    const endEncode = performance.now();
    console.log(`Encoding: ${endEncode - startEncode}`);

    return {
        state: data.state,
        recording: tmpGifBuffer,
        recordingName: 'event.gif'
    }
}