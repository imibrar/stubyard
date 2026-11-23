// The offscreen document (offscreen.html, reason USER_MEDIA): it only runs the video recorder of walkthrough
// recording R2 (videoRecorder.ts) for the service worker. Messages for it carry target 'offscreen'.
import type { ToOffscreen } from '../shared/video';
import { blobToBase64, type MediaRecorderCtor, VideoRecorder } from './videoRecorder';

const recorder = new VideoRecorder({
  getUserMedia: (c) => navigator.mediaDevices.getUserMedia(c),
  MediaRecorder: MediaRecorder as unknown as MediaRecorderCtor,
  send: (msg) => chrome.runtime.sendMessage(msg),
  toBase64: blobToBase64,
  now: () => performance.now(),
  setTimeout: (fn, ms) => setTimeout(fn, ms),
});

chrome.runtime.onMessage.addListener((msg: ToOffscreen, sender, reply) => {
  if (sender.id !== chrome.runtime.id || !msg || msg.target !== 'offscreen') return false;
  switch (msg.type) {
    case 'video.begin':
      void recorder.begin(msg.streamId, msg.session, msg.size).then(reply);
      return true;
    case 'video.pause':
      recorder.pause();
      break;
    case 'video.resume':
      recorder.resume();
      break;
    case 'video.step':
      recorder.step(msg.stepId);
      break;
    case 'video.stop':
      recorder.stop(msg.reason);
      break;
    case 'video.status':
      break;
  }
  reply(recorder.status());
  return false;
});
