import { Volume2, VolumeX } from 'lucide-react';
import { Button, IconButton } from '../components/ui.tsx';
import { setMuted, unlockAudio, useSoundSettings } from '../lib/sounds.ts';

/** Mutes this screen only; other viewers of the same dashboard are not affected. */
export function MuteButton() {
  const { muted } = useSoundSettings();
  return (
    <IconButton
      label={muted ? 'Unmute sounds on this screen' : 'Mute sounds on this screen'}
      aria-pressed={muted}
      onClick={() => setMuted(!muted)}
    >
      {muted ? <VolumeX className="size-4" /> : <Volume2 className="size-4" />}
    </IconButton>
  );
}

/** Browsers block audio until the page is clicked once; on a wall screen that click has to be deliberate. */
export function EnableSoundButton() {
  const { unlocked, muted } = useSoundSettings();
  if (unlocked || muted) return null;
  return (
    <Button
      size="sm"
      variant="accent"
      icon={<Volume2 className="size-4" />}
      onClick={() => void unlockAudio()}
    >
      Enable sound
    </Button>
  );
}
