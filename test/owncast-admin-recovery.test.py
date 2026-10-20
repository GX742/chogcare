"""Isolated recovery tests. No live WSL service, network, port or DB is touched.

Run with Linux Python: python3 -I -B test/owncast-admin-recovery.test.py
Every external operation is guarded and explicitly mocked before use.
"""

import base64
from contextlib import contextmanager, redirect_stderr, redirect_stdout
import importlib.util
import io
import json
from pathlib import Path
import signal
import stat
import subprocess
import sys
from types import SimpleNamespace
import unittest
from unittest.mock import ANY, MagicMock, patch
import urllib.error


source = Path(__file__).resolve().parents[1] / "scripts" / "owncast-admin-recovery.py"
spec = importlib.util.spec_from_file_location("isolated_owncast_admin_recovery", source)
recovery = importlib.util.module_from_spec(spec)
spec.loader.exec_module(recovery)

# This is synthetic test data, not an operator credential.
PASSWORD = "DemoOnlyAbc123!@"
ACCOUNT = SimpleNamespace(pw_uid=991, pw_gid=992)


@contextmanager
def mocked_reset():
    mocks = {
        "preflight": MagicMock(return_value=ACCOUNT),
        "protected_backup": MagicMock(return_value="isolated-backup"),
        "systemctl": MagicMock(return_value=(0, "")),
        "property_value": MagicMock(side_effect=lambda name: "0" if name == "MainPID" else "inactive"),
        "start_recovery": MagicMock(return_value=MagicMock(name="isolated-child")),
        "wait_for_saved": MagicMock(),
        "terminate_recovery": MagicMock(),
        "wait_for_normal": MagicMock(),
    }
    states = iter(["inactive", "active"])
    mocks["property_value"].side_effect = lambda name: "0" if name == "MainPID" else next(states)
    with patch.multiple(recovery, **mocks):
        yield mocks


class RecoveryTests(unittest.TestCase):
    def setUp(self):
        recovery._failure_phase = "INPUT"
        # Mistakes in a test must fail instead of reaching the machine.
        for target in (
            "subprocess.run", "subprocess.Popen", "os.killpg", "os.open",
            "sqlite3.connect", "urllib.request.build_opener",
        ):
            guard = patch(target, side_effect=AssertionError("Live external operations are forbidden in this test"))
            guard.start()
            self.addCleanup(guard.stop)
        guard = patch.object(Path, "mkdir", side_effect=AssertionError("Live directory writes are forbidden"))
        guard.start()
        self.addCleanup(guard.stop)
        guard = patch.object(recovery.signal, "signal")
        guard.start()
        self.addCleanup(guard.stop)

    def test_password_policy_rejects_unsafe_or_weak_values_before_preflight(self):
        self.assertTrue(recovery.validate_password(PASSWORD))
        invalid = [None, [], "shortA1!", "lowercaseonly123!", "UPPERCASEONLY123!", "NoNumbersPassword!", "NoSymbolsPassword123", "DemoOnly Abc123!", "DemoOnlyAbc123!\n", "DemoOnlyAbc123!\\", "DemoOnlyAbc123!\"", "ПарольAbc123!@#$", "A1!" + "a" * 70]
        with mocked_reset() as mocks:
            for value in invalid:
                self.assertFalse(recovery.validate_password(value))
                with self.assertRaises(recovery.RecoveryError):
                    recovery.reset_password(value)
            for mock in mocks.values():
                mock.assert_not_called()

    def test_error_phases_are_allowlisted_independently_of_secret_error_messages(self):
        self.assertEqual(recovery.PHASES, frozenset(("INPUT", "PREFLIGHT", "BACKUP", "STOP", "SPAWN", "SAVE", "CLEANUP", "RESTART", "VERIFY", "INTERNAL")))
        for phase in recovery.PHASES:
            with self.subTest(phase=phase):
                recovery._failure_phase = phase
                error = recovery.RecoveryError("Private argv: " + PASSWORD)
                self.assertEqual(error.phase, phase)
        self.assertEqual(recovery.RecoveryError(PASSWORD, phase=PASSWORD).phase, "INTERNAL")
        recovery._failure_phase = PASSWORD
        self.assertEqual(recovery.RecoveryError(PASSWORD).phase, "INTERNAL")

    def test_existing_755_backup_directory_fails_before_file_or_service_changes(self):
        # Metadata only: real checked_path receives fake paths/stat values, and
        # every filesystem write, database connection and service call is mocked.
        parent, backup_root = MagicMock(), MagicMock()
        for path in (parent, backup_root):
            path.resolve.return_value = path
            path.parents = ()
            path.is_symlink.return_value = False
            path.stat.return_value = SimpleNamespace(st_mode=stat.S_IFDIR | 0o755, st_uid=0)
        backup_root.parent = parent
        backup_root.mkdir.side_effect = FileExistsError()
        with patch.object(recovery, "BACKUPS", backup_root), patch.object(recovery, "preflight", return_value=ACCOUNT) as preflight, patch.object(recovery, "systemctl") as service, patch.object(recovery.os, "open") as opened, patch.object(recovery.sqlite3, "connect") as connect:
            with self.assertRaises(recovery.RecoveryError) as result:
                recovery.reset_password(PASSWORD)
        self.assertEqual(result.exception.phase, "BACKUP")
        self.assertIn("file permissions", str(result.exception))
        preflight.assert_called_once()
        backup_root.mkdir.assert_called_once_with(mode=0o700)
        backup_root.__truediv__.assert_not_called()
        opened.assert_not_called()
        connect.assert_not_called()
        service.assert_not_called()

    def test_save_failure_retains_save_phase_after_cleanup_and_restart(self):
        with mocked_reset() as mocks:
            def failed_save(child):
                recovery._failure_phase = "SAVE"
                raise RuntimeError("Private argv: " + PASSWORD)
            def cleanup(child):
                recovery._failure_phase = "CLEANUP"
            mocks["wait_for_saved"].side_effect = failed_save
            mocks["terminate_recovery"].side_effect = cleanup
            with self.assertRaises(recovery.RecoveryError) as result:
                recovery.reset_password(PASSWORD)
            self.assertEqual(result.exception.phase, "SAVE")
            self.assertEqual(recovery._failure_phase, "RESTART")
            self.assertNotIn(PASSWORD, str(result.exception))
            self.assertEqual(mocks["systemctl"].call_args_list[-1], unittest.mock.call("start"))

    def test_cleanup_and_restart_failures_override_original_phase_without_secret_details(self):
        for failed_phase in ("CLEANUP", "RESTART"):
            with self.subTest(phase=failed_phase), mocked_reset() as mocks:
                def failed_save(child):
                    recovery._failure_phase = "SAVE"
                    raise RuntimeError(PASSWORD)
                mocks["wait_for_saved"].side_effect = failed_save
                if failed_phase == "CLEANUP":
                    def failed_cleanup(child):
                        recovery._failure_phase = "CLEANUP"
                        raise recovery.RecoveryError("Fixed cleanup failure.")
                    mocks["terminate_recovery"].side_effect = failed_cleanup
                else:
                    mocks["systemctl"].side_effect = [(0, ""), (1, "")]
                with self.assertRaises(recovery.RecoveryError) as result:
                    recovery.reset_password(PASSWORD)
                self.assertEqual(result.exception.phase, failed_phase)
                self.assertNotIn(PASSWORD, str(result.exception))
                if failed_phase == "CLEANUP":
                    self.assertEqual(mocks["systemctl"].call_args_list, [unittest.mock.call("stop")])

    def test_success_backs_up_before_stopping_and_verifies_normal_service(self):
        with mocked_reset() as mocks:
            order = MagicMock()
            for name, mock in mocks.items():
                order.attach_mock(mock, name)
            recovery.reset_password(PASSWORD)
            self.assertEqual(mocks["preflight"].call_count, 2)
            names = [entry[0] for entry in order.mock_calls]
            self.assertLess(names.index("protected_backup"), names.index("systemctl"))
            self.assertEqual(mocks["systemctl"].call_args_list, [unittest.mock.call("stop"), unittest.mock.call("start")])
            mocks["start_recovery"].assert_called_once_with(PASSWORD, ACCOUNT)
            mocks["terminate_recovery"].assert_called_once_with(mocks["start_recovery"].return_value)
            mocks["wait_for_normal"].assert_called_once_with(PASSWORD)

    def test_preflight_or_backup_failure_cannot_stop_the_service(self):
        for failure in ("preflight", "protected_backup"):
            with self.subTest(failure=failure), mocked_reset() as mocks:
                mocks[failure].side_effect = recovery.RecoveryError("Fixed check failed.")
                with self.assertRaises(recovery.RecoveryError):
                    recovery.reset_password(PASSWORD)
                mocks["systemctl"].assert_not_called()
                mocks["start_recovery"].assert_not_called()

    def test_final_preflight_failure_preserves_running_service(self):
        with mocked_reset() as mocks:
            mocks["preflight"].side_effect = [ACCOUNT, recovery.RecoveryError("Setup changed.")]
            with self.assertRaises(recovery.RecoveryError):
                recovery.reset_password(PASSWORD)
            mocks["protected_backup"].assert_called_once()
            mocks["systemctl"].assert_not_called()
            mocks["start_recovery"].assert_not_called()

    def test_save_failure_terminates_child_and_restarts_without_leaking_exception(self):
        with mocked_reset() as mocks:
            mocks["wait_for_saved"].side_effect = RuntimeError("Private argv: " + PASSWORD)
            with self.assertRaises(recovery.RecoveryError) as result:
                recovery.reset_password(PASSWORD)
            self.assertNotIn(PASSWORD, str(result.exception))
            self.assertIn("backup was not restored", str(result.exception))
            mocks["terminate_recovery"].assert_called_once()
            self.assertEqual(mocks["systemctl"].call_args_list[-1], unittest.mock.call("start"))
            mocks["wait_for_normal"].assert_not_called()

    def test_spawn_failure_still_restarts_original_service(self):
        with mocked_reset() as mocks:
            mocks["start_recovery"].side_effect = OSError("Private argv: " + PASSWORD)
            mocks["property_value"].side_effect = lambda name: "0" if name == "MainPID" else "active"
            # Stop inspection must report inactive before the failed spawn.
            mocks["property_value"].side_effect = ["0", "inactive", "active"]
            with self.assertRaises(recovery.RecoveryError) as result:
                recovery.reset_password(PASSWORD)
            self.assertNotIn(PASSWORD, str(result.exception))
            mocks["terminate_recovery"].assert_not_called()
            self.assertEqual(mocks["systemctl"].call_args_list, [unittest.mock.call("stop"), unittest.mock.call("start")])

    def test_failed_or_timed_out_stop_attempts_service_restoration_without_spawn(self):
        for error in ((1, ""), recovery.RecoveryError("Stop timed out.")):
            with self.subTest(error=type(error).__name__), mocked_reset() as mocks:
                def service(action):
                    if action == "stop":
                        if isinstance(error, Exception):
                            raise error
                        return error
                    return 0, ""
                mocks["systemctl"].side_effect = service
                mocks["property_value"].return_value = "active"
                mocks["property_value"].side_effect = None
                with self.assertRaises(recovery.RecoveryError):
                    recovery.reset_password(PASSWORD)
                mocks["start_recovery"].assert_not_called()
                self.assertEqual(mocks["systemctl"].call_args_list[-1], unittest.mock.call("start"))

    def test_cleanup_failure_does_not_start_service_over_live_recovery_child(self):
        with mocked_reset() as mocks:
            mocks["terminate_recovery"].side_effect = recovery.RecoveryError("Child could not be stopped.")
            with self.assertRaises(recovery.RecoveryError):
                recovery.reset_password(PASSWORD)
            self.assertEqual(mocks["systemctl"].call_args_list, [unittest.mock.call("stop")])
            mocks["wait_for_normal"].assert_not_called()

    def test_restart_failure_is_not_reported_as_a_verified_reset(self):
        with mocked_reset() as mocks:
            mocks["systemctl"].side_effect = [(0, ""), (1, "")]
            with self.assertRaisesRegex(recovery.RecoveryError, "did not restart"):
                recovery.reset_password(PASSWORD)
            mocks["terminate_recovery"].assert_called_once()
            mocks["wait_for_normal"].assert_not_called()

    def test_post_restart_auth_failure_keeps_backup_and_does_not_repeat_reset(self):
        with mocked_reset() as mocks:
            mocks["wait_for_normal"].side_effect = recovery.RecoveryError("Password verification failed.")
            with self.assertRaises(recovery.RecoveryError):
                recovery.reset_password(PASSWORD)
            mocks["protected_backup"].assert_called_once()
            mocks["start_recovery"].assert_called_once()
            self.assertEqual(mocks["systemctl"].call_args_list[-1], unittest.mock.call("start"))

    def test_official_cli_uses_dropped_user_separate_argv_no_stream_key_or_secret_env(self):
        with patch.object(recovery.subprocess, "Popen", return_value=MagicMock()) as spawn:
            recovery.start_recovery(PASSWORD, ACCOUNT)
        args, options = spawn.call_args
        argv = args[0]
        self.assertEqual(argv[0], str(recovery.BINARY))
        self.assertEqual(argv[-2:], ["--adminpassword", PASSWORD])
        self.assertEqual(argv[argv.index("--database") + 1], str(recovery.DATABASE))
        self.assertEqual(argv[argv.index("--webserverip") + 1], "127.0.0.1")
        self.assertEqual(argv[argv.index("--webserverport") + 1], "8082")
        self.assertNotIn("--streamkey", argv)
        self.assertFalse(options.get("shell", False))
        self.assertEqual(options["user"], ACCOUNT.pw_uid)
        self.assertEqual(options["group"], ACCOUNT.pw_gid)
        self.assertEqual(options["extra_groups"], ())
        self.assertTrue(options["start_new_session"])
        self.assertNotIn(PASSWORD, json.dumps(options["env"]))

    def test_service_commands_are_scoped_and_subprocess_errors_are_sanitized(self):
        result = SimpleNamespace(returncode=0, stdout=b"active\n")
        with patch.object(recovery.subprocess, "run", return_value=result) as run:
            self.assertEqual(recovery.systemctl("start"), (0, "active"))
            self.assertEqual(run.call_args.args[0], ["/usr/bin/systemctl", "start", "owncast.service"])
            self.assertLessEqual(run.call_args.kwargs["timeout"], 30)
        with patch.object(recovery.subprocess, "run", side_effect=subprocess.TimeoutExpired([PASSWORD], 30)):
            with self.assertRaises(recovery.RecoveryError) as result:
                recovery.systemctl("stop")
            self.assertNotIn(PASSWORD, str(result.exception))

    def test_admin_verification_does_not_read_secret_body_or_follow_redirects(self):
        response = MagicMock(status=200)
        response.__enter__.return_value = response
        opener = MagicMock()
        opener.open.return_value = response
        with patch.object(recovery.urllib.request, "build_opener", return_value=opener) as build:
            self.assertEqual(recovery.local_status("/api/admin/serverconfig", PASSWORD), (200, None))
        response.read.assert_not_called()
        request = opener.open.call_args.args[0]
        self.assertEqual(request.full_url, "http://127.0.0.1:8082/api/admin/serverconfig")
        self.assertEqual(request.get_method(), "GET")
        expected = "Basic " + base64.b64encode(("admin:" + PASSWORD).encode()).decode()
        self.assertEqual(request.get_header("Authorization"), expected)
        self.assertEqual(opener.open.call_args.kwargs["timeout"], 2)
        self.assertTrue(any(isinstance(arg, recovery.NoRedirect) for arg in build.call_args.args))
        proxy = next(arg for arg in build.call_args.args if isinstance(arg, recovery.urllib.request.ProxyHandler))
        self.assertEqual(proxy.proxies, {})
        self.assertIsNone(recovery.NoRedirect().redirect_request(request, None, 302, "", {}, "https://untrusted.invalid/"))

    def test_http_error_status_is_closed_and_unexpected_routes_are_rejected(self):
        opener = MagicMock()
        error = urllib.error.HTTPError("http://127.0.0.1:8082", 302, "Redirect", {}, None)
        with patch.object(error, "close") as close, patch.object(recovery.urllib.request, "build_opener", return_value=opener):
            opener.open.side_effect = error
            self.assertEqual(recovery.local_status("/api/admin/serverconfig", PASSWORD), (302, None))
            close.assert_called_once()
            with self.assertRaises(recovery.RecoveryError):
                recovery.local_status("/api/payments/config", PASSWORD)
        error.close()

    def test_normal_service_verification_requires_version_unauthenticated_401_and_basic_200(self):
        with patch.object(recovery, "local_status", side_effect=[(200, recovery.VERSION), (401, None), (200, None)]) as status, patch.object(recovery.time, "monotonic", side_effect=[0, 1]):
            recovery.wait_for_normal(PASSWORD)
            self.assertEqual(status.call_args_list, [unittest.mock.call("/api/config", public_config=True), unittest.mock.call("/api/admin/serverconfig"), unittest.mock.call("/api/admin/serverconfig", PASSWORD)])
        with patch.object(recovery, "local_status", side_effect=[(200, recovery.VERSION), (200, None)]), patch.object(recovery.time, "monotonic", side_effect=[0, 1]):
            with self.assertRaisesRegex(recovery.RecoveryError, "Admin protection"):
                recovery.wait_for_normal(PASSWORD)

    def test_rejected_new_password_fails_once_without_repeated_login_or_success(self):
        with patch.object(recovery, "local_status", side_effect=[(200, recovery.VERSION), (401, None), (401, None)]) as status, patch.object(recovery.time, "monotonic", side_effect=[0, 1]), patch.object(recovery.time, "sleep") as sleep:
            with self.assertRaisesRegex(recovery.RecoveryError, "rejected the new password"):
                recovery.wait_for_normal(PASSWORD)
            self.assertEqual(status.call_count, 3)
            sleep.assert_not_called()

    def test_child_cleanup_kills_only_its_created_group_with_bounded_escalation(self):
        child = MagicMock(pid=12345)
        child.poll.return_value = None
        child.wait.side_effect = [subprocess.TimeoutExpired("synthetic", 5), 0]
        with patch.object(recovery.os, "killpg") as kill:
            recovery.terminate_recovery(child)
            self.assertEqual(kill.call_args_list, [unittest.mock.call(child.pid, signal.SIGTERM), unittest.mock.call(child.pid, signal.SIGKILL)])
        self.assertEqual(child.wait.call_args_list, [unittest.mock.call(timeout=5), unittest.mock.call(timeout=5)])
        child.stdout.close.assert_called_once()

    def test_failed_child_cleanup_reports_fixed_error_and_closes_pipe(self):
        child = MagicMock(pid=12345)
        child.poll.return_value = None
        with patch.object(recovery.os, "killpg", side_effect=OSError(PASSWORD)):
            with self.assertRaises(recovery.RecoveryError) as result:
                recovery.terminate_recovery(child)
        self.assertNotIn(PASSWORD, str(result.exception))
        child.stdout.close.assert_called_once()

    def test_backup_uses_exclusive_root_only_file_and_readonly_online_sqlite_backup(self):
        backup_root, backup_file = MagicMock(), MagicMock()
        backup_root.__truediv__.return_value = backup_file
        backup_file.as_uri.return_value = "file:///isolated/backup.db"
        database = MagicMock()
        database.as_uri.return_value = "file:///isolated/source.db"
        source_conn, target_conn = MagicMock(), MagicMock()
        source_conn.__enter__.return_value = source_conn
        target_conn.__enter__.return_value = target_conn
        with patch.object(recovery, "BACKUPS", backup_root), patch.object(recovery, "DATABASE", database), patch.object(recovery, "checked_path") as check, patch.object(recovery.os, "open", return_value=22) as opened, patch.object(recovery.os, "close") as closed, patch.object(recovery.sqlite3, "connect", side_effect=[source_conn, target_conn]) as connect:
            self.assertIs(recovery.protected_backup(), backup_file)
        opened.assert_called_once_with(backup_file, recovery.os.O_WRONLY | recovery.os.O_CREAT | recovery.os.O_EXCL | recovery.os.O_NOFOLLOW, 0o600)
        closed.assert_called_once_with(22)
        backup_root.mkdir.assert_called_once_with(mode=0o700)
        self.assertEqual(connect.call_args_list, [unittest.mock.call("file:///isolated/source.db?mode=ro", uri=True, timeout=5), unittest.mock.call("file:///isolated/backup.db?mode=rw", uri=True, timeout=5)])
        source_conn.backup.assert_called_once_with(target_conn, pages=128, progress=ANY, sleep=0.05)
        source_conn.execute.assert_not_called()
        source_conn.close.assert_called_once()
        target_conn.close.assert_called_once()
        self.assertIn(unittest.mock.call(backup_file, owner=0, mode=0o600), check.call_args_list)

    def test_main_check_and_graceful_signal_handlers_do_not_run_recovery(self):
        stdout, stderr = io.StringIO(), io.StringIO()
        with patch.object(recovery.sys, "argv", ["helper", "--check"]), patch.object(recovery, "preflight") as preflight, patch.object(recovery, "reset_password") as reset, patch.object(recovery.signal, "signal") as register, redirect_stdout(stdout), redirect_stderr(stderr):
            self.assertEqual(recovery.main(), 0)
            preflight.assert_called_once()
            reset.assert_not_called()
            self.assertEqual([call.args[0] for call in register.call_args_list], [signal.SIGINT, signal.SIGTERM, signal.SIGHUP])
            handler = register.call_args_list[0].args[1]
            for signum in (signal.SIGINT, signal.SIGTERM, signal.SIGHUP):
                with self.assertRaises(recovery.RecoveryError):
                    handler(signum, None)
        self.assertEqual(stdout.getvalue(), "PREFLIGHT_OK\n")
        self.assertEqual(stderr.getvalue(), "")

    def test_signal_exception_during_save_attempts_child_and_service_cleanup(self):
        with mocked_reset() as mocks:
            mocks["wait_for_saved"].side_effect = recovery.RecoveryError("Recovery cancelled; normal-service cleanup was attempted.")
            with self.assertRaises(recovery.RecoveryError):
                recovery.reset_password(PASSWORD)
            mocks["terminate_recovery"].assert_called_once()
            self.assertEqual(mocks["systemctl"].call_args_list[-1], unittest.mock.call("start"))

    def test_main_never_prints_raw_exception_or_stdin_secret(self):
        frame = (json.dumps({"password": PASSWORD}) + "\n").encode()
        for failure in (RuntimeError("Private argv: " + PASSWORD), recovery.RecoveryError("Fixed failure.")):
            stdout, stderr = io.StringIO(), io.StringIO()
            with patch.object(recovery.sys, "argv", ["helper"]), patch.object(recovery.sys, "stdin", SimpleNamespace(buffer=io.BytesIO(frame))), patch.object(recovery, "reset_password", side_effect=failure), redirect_stdout(stdout), redirect_stderr(stderr):
                self.assertEqual(recovery.main(), 1)
            self.assertNotIn(PASSWORD, stdout.getvalue() + stderr.getvalue())
            self.assertNotIn("Traceback", stderr.getvalue())
            self.assertNotIn("Private argv", stderr.getvalue())

    def test_main_prints_only_exact_stage_codes_even_when_messages_contain_credentials(self):
        frame = (json.dumps({"password": PASSWORD}) + "\n").encode()
        for phase in recovery.PHASES:
            stdout, stderr = io.StringIO(), io.StringIO()
            failure = recovery.RecoveryError("Private argv: " + PASSWORD, phase=phase)
            with self.subTest(phase=phase), patch.object(recovery.sys, "argv", ["helper"]), patch.object(recovery.sys, "stdin", SimpleNamespace(buffer=io.BytesIO(frame))), patch.object(recovery, "reset_password", side_effect=failure), redirect_stdout(stdout), redirect_stderr(stderr):
                self.assertEqual(recovery.main(), 1)
            self.assertEqual(stdout.getvalue(), "")
            self.assertEqual(stderr.getvalue(), "RECOVERY_ERROR:" + phase + "\n")

    def test_main_maps_raw_stage_exceptions_and_unknown_phase_without_leaking_details(self):
        frame = (json.dumps({"password": PASSWORD}) + "\n").encode()
        for phase in ("BACKUP", "SPAWN", PASSWORD):
            def failed_reset(password):
                recovery._failure_phase = phase
                raise OSError("Private argv: " + password)
            stdout, stderr = io.StringIO(), io.StringIO()
            with self.subTest(phase=phase), patch.object(recovery.sys, "argv", ["helper"]), patch.object(recovery.sys, "stdin", SimpleNamespace(buffer=io.BytesIO(frame))), patch.object(recovery, "reset_password", side_effect=failed_reset), redirect_stdout(stdout), redirect_stderr(stderr):
                self.assertEqual(recovery.main(), 1)
            expected = phase if phase in recovery.PHASES else "INTERNAL"
            self.assertEqual(stdout.getvalue(), "")
            self.assertEqual(stderr.getvalue(), "RECOVERY_ERROR:" + expected + "\n")

    def test_main_accepts_only_one_bounded_password_frame(self):
        invalid = [b"", b"{}\n", b'{"password":"unused","extra":1}\n', b'{"password":"unterminated"}', b"x" * 4097 + b"\n"]
        for frame in invalid:
            stdout, stderr = io.StringIO(), io.StringIO()
            with self.subTest(length=len(frame)), patch.object(recovery.sys, "argv", ["helper"]), patch.object(recovery.sys, "stdin", SimpleNamespace(buffer=io.BytesIO(frame))), patch.object(recovery, "reset_password") as reset, redirect_stdout(stdout), redirect_stderr(stderr):
                self.assertEqual(recovery.main(), 1)
                reset.assert_not_called()
                self.assertEqual(stdout.getvalue(), "")
                self.assertEqual(stderr.getvalue(), "RECOVERY_ERROR:INPUT\n")


if __name__ == "__main__":
    unittest.main(verbosity=2)
