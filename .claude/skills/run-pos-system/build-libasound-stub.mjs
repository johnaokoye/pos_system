/**
 * Builds /tmp/libasound.so.2 — a minimal stub shared library that satisfies
 * Chromium's ALSA dependency on systems where libasound2 is not installed.
 *
 * Requires: `as` and `ld` from binutils (available on Ubuntu by default).
 * No sudo needed; the output is a user-writable file in /tmp.
 */
import { execSync } from 'child_process';
import { mkdtempSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

// Symbols required by chromium-1223 (determined via `objdump -R chrome`).
const SYMBOLS_ALSA_0_9 = [
  'snd_card_next','snd_ctl_card_info','snd_ctl_card_info_get_driver',
  'snd_ctl_card_info_get_longname','snd_ctl_card_info_get_name',
  'snd_ctl_card_info_sizeof','snd_ctl_close','snd_ctl_hwdep_info',
  'snd_ctl_hwdep_next_device','snd_ctl_open','snd_ctl_rawmidi_next_device',
  'snd_device_name_free_hint','snd_device_name_get_hint','snd_device_name_hint',
  'snd_hwdep_info_get_iface','snd_hwdep_info_sizeof',
  'snd_midi_event_decode','snd_midi_event_encode_byte','snd_midi_event_free',
  'snd_midi_event_new','snd_midi_event_no_status',
  'snd_mixer_attach','snd_mixer_close','snd_mixer_detach',
  'snd_mixer_elem_get_callback_private','snd_mixer_elem_next',
  'snd_mixer_elem_set_callback','snd_mixer_elem_set_callback_private',
  'snd_mixer_find_selem','snd_mixer_first_elem','snd_mixer_free',
  'snd_mixer_handle_events','snd_mixer_load','snd_mixer_open',
  'snd_mixer_poll_descriptors','snd_mixer_poll_descriptors_count',
  'snd_mixer_selem_ask_playback_dB_vol','snd_mixer_selem_ask_playback_vol_dB',
  'snd_mixer_selem_get_capture_volume','snd_mixer_selem_get_capture_volume_range',
  'snd_mixer_selem_get_name','snd_mixer_selem_get_playback_switch',
  'snd_mixer_selem_get_playback_volume','snd_mixer_selem_get_playback_volume_range',
  'snd_mixer_selem_has_capture_volume','snd_mixer_selem_has_playback_switch',
  'snd_mixer_selem_has_playback_volume','snd_mixer_selem_id_free',
  'snd_mixer_selem_id_malloc','snd_mixer_selem_id_set_index',
  'snd_mixer_selem_id_set_name','snd_mixer_selem_is_active',
  'snd_mixer_selem_register','snd_mixer_selem_set_capture_volume_all',
  'snd_mixer_selem_set_playback_switch','snd_mixer_selem_set_playback_switch_all',
  'snd_mixer_selem_set_playback_volume_all',
  'snd_pcm_avail_update','snd_pcm_close','snd_pcm_delay','snd_pcm_drop',
  'snd_pcm_drain','snd_pcm_format_size','snd_pcm_get_params',
  'snd_pcm_hw_params','snd_pcm_hw_params_any','snd_pcm_hw_params_can_resume',
  'snd_pcm_hw_params_free','snd_pcm_hw_params_malloc',
  'snd_pcm_hw_params_set_access','snd_pcm_hw_params_set_channels',
  'snd_pcm_hw_params_set_format','snd_pcm_hw_params_set_rate_resample',
  'snd_pcm_hw_params_test_format','snd_pcm_name','snd_pcm_open',
  'snd_pcm_prepare','snd_pcm_readi','snd_pcm_recover','snd_pcm_resume',
  'snd_pcm_set_params','snd_pcm_start','snd_pcm_state',
  'snd_pcm_sw_params','snd_pcm_sw_params_current','snd_pcm_sw_params_free',
  'snd_pcm_sw_params_malloc','snd_pcm_sw_params_set_avail_min',
  'snd_pcm_sw_params_set_start_threshold','snd_pcm_writei',
  'snd_seq_client_id','snd_seq_client_info_get_client',
  'snd_seq_client_info_get_name','snd_seq_client_info_get_type',
  'snd_seq_client_info_set_client','snd_seq_client_info_sizeof',
  'snd_seq_close','snd_seq_create_simple_port','snd_seq_delete_simple_port',
  'snd_seq_event_input','snd_seq_event_input_pending',
  'snd_seq_event_output_direct','snd_seq_get_any_client_info',
  'snd_seq_get_any_port_info','snd_seq_open','snd_seq_poll_descriptors',
  'snd_seq_port_info_get_addr','snd_seq_port_info_get_capability',
  'snd_seq_port_info_get_name','snd_seq_port_info_get_type',
  'snd_seq_port_info_set_client','snd_seq_port_info_set_port',
  'snd_seq_port_info_sizeof','snd_seq_port_subscribe_set_dest',
  'snd_seq_port_subscribe_set_sender','snd_seq_port_subscribe_sizeof',
  'snd_seq_query_next_client','snd_seq_query_next_port',
  'snd_seq_set_client_name','snd_seq_subscribe_port','snd_strerror',
];

// These four need ALSA_0.9.0rc4 (not just ALSA_0.9)
const SYMBOLS_RC4 = [
  'snd_pcm_hw_params_get_channels_min',
  'snd_pcm_hw_params_set_buffer_size_near',
  'snd_pcm_hw_params_set_period_size_near',
  'snd_pcm_hw_params_set_rate_near',
];

const dir = mkdtempSync(join(tmpdir(), 'libasound-stub-'));

let asm = '.text\n';
for (const sym of SYMBOLS_ALSA_0_9) {
  asm += `.global ${sym}_v09\n.type ${sym}_v09, @function\n${sym}_v09:\n  xor %eax, %eax\n  ret\n.symver ${sym}_v09, ${sym}@ALSA_0.9\n`;
}
for (const sym of SYMBOLS_RC4) {
  asm += `.global ${sym}_rc4\n.type ${sym}_rc4, @function\n${sym}_rc4:\n  xor %eax, %eax\n  ret\n.symver ${sym}_rc4, ${sym}@ALSA_0.9.0rc4\n`;
}

const ver = `ALSA_0.9 { global: *; };\nALSA_0.9.0rc4 { global: *; };\n`;

const asmFile = join(dir, 'stub.s');
const verFile = join(dir, 'stub.ver');
const objFile = join(dir, 'stub.o');
const outFile = '/tmp/libasound.so.2';

writeFileSync(asmFile, asm);
writeFileSync(verFile, ver);
execSync(`as --64 -o ${objFile} ${asmFile}`);
execSync(`ld -shared -soname libasound.so.2 --version-script=${verFile} -o ${outFile} ${objFile}`);

console.log('Built', outFile);
