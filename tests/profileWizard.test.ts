import { describe, it, expect } from 'vitest';
import { macosVerificationNoticeUrl } from '../src/ui/profileWizard';

describe('macosVerificationNoticeUrl', () => {
  it('points macOS users at the verification issue', () => {
    expect(macosVerificationNoticeUrl('macos'))
      .toBe('https://github.com/tayloraaron078-tech/Filament_Calibration_Wizard/issues/24');
  });

  it('shows nothing on Windows, where direct install is already verified', () => {
    expect(macosVerificationNoticeUrl('windows')).toBeNull();
  });

  it('shows nothing on Linux, which is being verified separately', () => {
    expect(macosVerificationNoticeUrl('linux')).toBeNull();
  });
});
