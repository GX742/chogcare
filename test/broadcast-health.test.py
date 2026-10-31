import copy
import importlib.util
import io
import json
import os
from pathlib import Path
import stat
import sys
import tempfile
import unittest
from unittest.mock import Mock, patch

ROOT = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location("broadcast_health", ROOT / "ops/owncast/broadcast-health.py")
health = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(health)


def playlist(source=False, sequence=1, count=3, session="Synthetic-Session"):
    lines = ["#EXTM3U", "#EXT-X-VERSION:6", "#EXT-X-TARGETDURATION:1" if source else "#EXT-X-TARGETDURATION:6", f"#EXT-X-MEDIA-SEQUENCE:{sequence}", "#EXT-X-INDEPENDENT-SEGMENTS"]
    for index in range(sequence, sequence + count):
        lines.extend(["#EXTINF:1.000," if source else "#EXTINF:6.000,",
                      f"stream-{session}-{index}.ts" if source else f"stream-{index}.ts"])
    return "\n".join(lines) + "\n"


def observation(source=1, mobile=1, preview=1, mobile_pid=11, preview_pid=22, mobile_started=0, preview_started=0):
    identity = lambda value: health.digest(str(value)) if value is not None else None
    return {"source": identity(source), "mobile": identity(mobile), "preview": identity(preview),
            "services": {"mobile": {"active": True, "pid": mobile_pid, "started_at": mobile_started},
                         "preview": {"active": True, "pid": preview_pid, "started_at": preview_started}}}


class Decisions(unittest.TestCase):
    def setUp(self):
        self.state = None

    def step(self, now, value=None, boot="boot-one"):
        previous = self.state
        old = copy.deepcopy(self.state)
        value = observation() if value is None else value
        original = copy.deepcopy(value)
        self.state, actions = health.evaluate(self.state, value, now, boot)
        self.assertEqual(value, original)
        self.assertEqual(previous, old)
        if old is not None:
            self.assertIsNot(self.state, old)
        return actions

    def prime(self):
        self.assertEqual(self.step(1000), [])
        self.assertEqual(self.step(1090, observation(2, 2, 2)), [])

    def test_healthy_progress_never_requests_recovery(self):
        self.prime()
        for now in range(1105, 1400, 15):
            self.assertEqual(self.step(now, observation(now, now, now)), [])

    def test_successful_but_unchanged_source_never_authorizes_restart(self):
        self.step(1000)
        for now in range(1015, 1400, 15):
            self.assertEqual(self.step(now, observation(1, 1, 1)), [])

    def test_source_absent_or_malformed_suppresses_all_recovery(self):
        self.prime()
        for now in (1120, 1140, 1160):
            self.assertEqual(self.step(now, observation(None, None, None)), [])

    def test_mobile_stale_while_source_advances_recovers_only_mobile(self):
        self.prime()
        self.assertEqual(self.step(1120, observation(3, 2, 2)), [health.UNITS["mobile"]])

    def test_missing_or_malformed_mobile_counts_as_no_output_progress(self):
        self.prime()
        self.assertEqual(self.step(1121, observation(3, None, 2)), [health.UNITS["mobile"]])

    def test_preview_stale_while_mobile_advances_recovers_only_preview(self):
        self.prime()
        self.assertEqual(self.step(1111, observation(3, 3, 2)), [health.UNITS["preview"]])

    def test_missing_preview_is_recovered_with_fresh_upstream(self):
        self.prime()
        self.assertEqual(self.step(1111, observation(3, 3, None)), [health.UNITS["preview"]])

    def test_preview_is_not_restarted_against_a_stalled_mobile_upstream(self):
        self.prime()
        self.assertEqual(self.step(1121, observation(3, 2, 2)), [health.UNITS["mobile"]])

    def test_first_valid_observation_is_not_proof_of_advancement(self):
        self.step(1000, observation(None, None, None))
        self.assertEqual(self.step(1100, observation(1, 1, 1)), [])
        self.assertEqual(self.step(1110, observation(1, 1, 1)), [])

    def test_monitor_and_producer_receive_ninety_second_startup_grace(self):
        self.step(1000, observation(mobile_started=1000, preview_started=1000))
        self.assertEqual(self.step(1089, observation(2, 1, 1, mobile_started=1000, preview_started=1000)), [])
        self.assertEqual(self.step(1090, observation(3, 1, 1, mobile_started=1000, preview_started=1000)), [health.UNITS["mobile"]])

    def test_service_restart_resets_output_observation_and_grace(self):
        self.prime()
        self.assertEqual(self.step(1100, observation(3, 2, 2, mobile_pid=33, mobile_started=1100)), [])
        self.assertEqual(self.step(1189, observation(4, 2, 2, mobile_pid=33, mobile_started=1100)), [])
        self.assertEqual(self.step(1190, observation(5, 2, 2, mobile_pid=33, mobile_started=1100)), [health.UNITS["mobile"]])

    def test_cooldown_is_persisted_and_backs_off(self):
        self.prime()
        self.assertEqual(self.step(1120, observation(3, 2, 2)), [health.UNITS["mobile"]])
        self.assertEqual(self.state["units"]["mobile"]["next_allowed"], 1240)
        self.assertEqual(self.step(1239, observation(4, 2, 2)), [])
        self.assertEqual(self.step(1240, observation(5, 2, 2)), [health.UNITS["mobile"]])
        self.assertEqual(self.state["units"]["mobile"]["next_allowed"], 1480)
        self.assertEqual(self.step(1479, observation(6, 2, 2)), [])
        self.assertEqual(self.step(1480, observation(7, 2, 2)), [health.UNITS["mobile"]])
        self.assertEqual(self.state["units"]["mobile"]["next_allowed"], 1960)

    def test_backoff_is_capped_even_after_many_failed_recoveries(self):
        self.prime()
        self.state["units"]["mobile"].update(attempts=12, last_attempt=1080, next_allowed=1090)
        self.assertEqual(self.step(1120, observation(3, 2, 2)), [health.UNITS["mobile"]])
        self.assertEqual(self.state["units"]["mobile"]["next_allowed"], 2020)

    def test_manual_stops_are_not_undone(self):
        self.prime()
        value = observation(3, 2, 2)
        value["services"]["mobile"]["active"] = False
        self.assertEqual(self.step(1120, value), [])

    def test_reboot_backwards_clock_and_long_resume_gap_reset_safely(self):
        for now, boot in [(1120, "new-boot"), (1, "boot-one"), (2000, "boot-one")]:
            with self.subTest(now=now, boot=boot):
                self.state = None
                self.prime()
                self.assertEqual(self.step(now, observation(3, 2, 2), boot), [])
                self.assertEqual(self.state["monitor_started_at"], now)

    def test_corrupt_or_unexpected_state_cannot_trigger_recovery(self):
        invalid = [None, [], {}, {"version": 1}, "state", {"unexpected": "metadata"}]
        for previous in invalid:
            state, actions = health.evaluate(previous, observation(), 1000, "boot-one")
            self.assertEqual(actions, [])
            self.assertEqual(set(state), {"version", "boot", "checked_at", "monitor_started_at", "tracks", "units"})
        self.prime()
        self.state["units"]["mobile"]["next_allowed"] = float("nan")
        self.assertEqual(self.step(1120, observation(3, 2, 2)), [])

    def test_old_attempts_reset_only_after_sustained_time_and_real_progress(self):
        self.prime()
        self.step(1120, observation(3, 2, 2))
        for now in range(1135, 1746, 15):
            self.step(now, observation(now, now, now))
        self.assertEqual(self.state["units"]["mobile"]["attempts"], 0)

    def test_late_single_progress_blip_does_not_collapse_backoff(self):
        self.prime()
        self.step(1120, observation(3, 2, 2))
        self.state["units"]["mobile"].update(attempts=8, next_allowed=2020)
        for now in (1320, 1520):
            self.assertEqual(self.step(now, observation(now, 2, 2)), [])
        self.assertEqual(self.step(1720, observation(6, 6, 6)), [])
        self.assertEqual(self.state["units"]["mobile"]["attempts"], 8)
        self.assertEqual(self.state["units"]["mobile"]["next_allowed"], 2020)
        self.assertEqual(self.state["units"]["mobile"]["healthy_since"], 1720)

    def test_unobserved_gap_or_stale_upstream_restarts_the_health_streak(self):
        self.prime()
        self.step(1105, observation(3, 3, 3))
        self.assertEqual(self.state["units"]["mobile"]["healthy_since"], 1090)
        self.step(1130, observation(4, 4, 4))
        self.assertEqual(self.state["units"]["mobile"]["healthy_since"], 1130)
        self.step(1145, observation(None, 5, 5))
        self.assertIsNone(self.state["units"]["mobile"]["healthy_since"])


class ParsingAndBoundaries(unittest.TestCase):
    def test_identity_changes_only_with_actual_sequence_or_segment_progress(self):
        source = playlist(True)
        identity = health.playlist_identity(source, True)
        self.assertEqual(identity, health.playlist_identity(source, True))
        self.assertNotEqual(identity, health.playlist_identity(playlist(True, sequence=2), True))
        self.assertNotEqual(identity, health.playlist_identity(playlist(True, session="New_Session"), True))
        self.assertRegex(identity, r"^[0-9a-f]{64}$")
        self.assertNotIn("Session", identity)
        health.playlist_identity(playlist())

    def test_invalid_oversized_ended_or_redirecting_playlists_are_rejected(self):
        original = playlist(True)
        invalid = ["", "x" * 65537, original.replace("#EXTM3U", "invalid"), original + "#EXT-X-ENDLIST\n",
                   original.replace("#EXT-X-TARGETDURATION:1", "#EXT-X-TARGETDURATION:0"),
                   original.replace("#EXT-X-MEDIA-SEQUENCE:1", "#EXT-X-MEDIA-SEQUENCE:1\n#EXT-X-MEDIA-SEQUENCE:2"),
                   original.replace("stream-Synthetic-Session-1.ts", "https://elsewhere.invalid/private"),
                   original.replace("stream-Synthetic-Session-1.ts", "../../private"),
                   original.replace("#EXTINF:1.000,", "#EXTINF:0.000,"), playlist(True, count=129)]
        for text in invalid:
            with self.subTest(length=len(text)):
                with self.assertRaises(ValueError):
                    health.playlist_identity(text, True)

    def test_source_reader_is_fixed_bounded_and_refuses_environment_proxies(self):
        response = io.BytesIO(playlist(True).encode())
        response.status = 200
        opener = Mock()
        opener.open.return_value = response
        with patch.object(health.urllib.request, "build_opener", return_value=opener) as factory:
            self.assertRegex(health.source_identity(), r"^[0-9a-f]{64}$")
            opener.open.assert_called_once_with(health.SOURCE, timeout=2)
            self.assertEqual(factory.call_args.args[0].proxies, {})
            self.assertIsInstance(factory.call_args.args[1], health.NoRedirect)
        self.assertIsNone(health.NoRedirect().redirect_request(None, None, 302, None, None, None))

    def test_recovery_has_only_two_fixed_targets_and_never_uses_a_shell(self):
        runner = Mock(return_value=Mock(returncode=0))
        for unit in health.UNITS.values():
            self.assertTrue(health.restart_unit(unit, runner))
            self.assertEqual(runner.call_args.args[0], ["/bin/systemctl", "try-restart", "--no-block", unit])
            self.assertNotIn("shell", runner.call_args.kwargs)
        for unit in ["owncast.service", "nginx.service", "chogcare-payments.service", "anything; command"]:
            with self.assertRaises(ValueError):
                health.restart_unit(unit, runner)
        self.assertEqual(runner.call_count, 2)

    @unittest.skipUnless(sys.platform == "linux", "Linux filesystem hardening")
    def test_local_files_reject_symlinks_hardlinks_and_oversized_content(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "file"
            path.write_bytes(b"safe")
            self.assertEqual(health.read_regular(path, 4), b"safe")
            link = Path(directory) / "symlink"
            link.symlink_to(path)
            with self.assertRaises(OSError):
                health.read_regular(link, 4)
            hard = Path(directory) / "hardlink"
            os.link(path, hard)
            with self.assertRaises(ValueError):
                health.read_regular(path, 4)
            hard.unlink()
            with self.assertRaises(ValueError):
                health.read_regular(path, 3)

    @unittest.skipUnless(sys.platform == "linux", "Linux filesystem hardening")
    def test_atomic_private_state_is_bounded_and_contains_only_health_metadata(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "state.json"
            state, _ = health.evaluate(None, observation(), 1000, "boot-one")
            health.atomic_state(path, state)
            self.assertEqual(json.loads(health.read_regular(path, health.MAX_STATE, True)), state)
            self.assertEqual(stat.S_IMODE(path.stat().st_mode), 0o600)
            self.assertEqual(list(Path(directory).glob(".health-*")), [])
            with self.assertRaises(ValueError):
                health.atomic_state(path, {"oversized": "x" * health.MAX_STATE})
            path.chmod(0o644)
            with self.assertRaises(ValueError):
                health.read_regular(path, health.MAX_STATE, True)

    @unittest.skipUnless(sys.platform == "linux", "Linux filesystem timestamp precision")
    def test_preview_progress_uses_write_timestamp_not_changing_camera_pixels(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "preview.jpg"
            path.write_bytes(b"same static camera frame")
            with patch.object(health, "PREVIEW", path):
                initial = health.preview_identity()
                os.utime(path, ns=(1000000000, 2000000000))
                self.assertNotEqual(initial, health.preview_identity())


class ServiceContract(unittest.TestCase):
    def test_hardened_timer_runs_only_the_fixed_health_entrypoint(self):
        unit = (ROOT / "ops/owncast/chogcare-broadcast-health.service").read_text()
        timer = (ROOT / "ops/owncast/chogcare-broadcast-health.timer").read_text()
        self.assertIn("Type=oneshot", unit)
        self.assertIn("StateDirectoryMode=0700", unit)
        self.assertIn("ProtectSystem=strict", unit)
        self.assertIn("NoNewPrivileges=true", unit)
        self.assertIn("ExecStart=/usr/bin/python3 -B /usr/local/lib/chogcare/broadcast-health.py", unit)
        self.assertIn("OnBootSec=30s", timer)
        self.assertIn("OnUnitInactiveSec=15s", timer)
        self.assertIn("WantedBy=timers.target", timer)


if __name__ == "__main__":
    unittest.main()
