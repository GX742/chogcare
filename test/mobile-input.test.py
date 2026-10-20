import importlib.util
import pathlib
import unittest
import http.client
import io
import threading
import urllib.error
from unittest.mock import patch, Mock

spec = importlib.util.spec_from_file_location("mobile_input", pathlib.Path(__file__).parents[1] / "ops/owncast/mobile-input.py")
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


def playlist(count=25, session="TestABC"):
    text = "#EXTM3U\n#EXT-X-VERSION:6\n#EXT-X-TARGETDURATION:1\n#EXT-X-MEDIA-SEQUENCE:100\n#EXT-X-INDEPENDENT-SEGMENTS\n"
    for number in range(count):
        text += f"#EXTINF:1.000000,\n#EXT-X-PROGRAM-DATE-TIME:2026-10-18T10:50:00.000+0300\nstream-{session}-{number}.ts\n"
    return text


class LiveWindowTests(unittest.TestCase):
    def test_only_latest_completed_segments_and_advanced_sequence(self):
        result = module.live_window(playlist())
        self.assertIn("#EXT-X-MEDIA-SEQUENCE:122\n", result)
        self.assertEqual(result.count("#EXTINF:"), 3)
        self.assertNotIn("stream-TestABC-21.ts", result)
        self.assertIn("http://127.0.0.1:8082/hls/0/stream-TestABC-24.ts", result)

    def test_short_startup_window_keeps_correct_sequence(self):
        result = module.live_window(playlist(1))
        self.assertIn("#EXT-X-MEDIA-SEQUENCE:100\n", result)
        self.assertEqual(result.count("#EXTINF:"), 1)

    def test_url_safe_owncast_session_ids_keep_mobile_stream_alive(self):
        # Owncast regenerates this random ID when its source stream restarts.
        # A hyphenated production ID previously made the helper return 503.
        for session in ["nrv6-cjDR", "Test_ABC", "A_-b", "A" * 64]:
            with self.subTest(session=session):
                result = module.live_window(playlist(session=session))
                self.assertEqual(result.count("#EXTINF:"), 3)
                self.assertIn("#EXT-X-MEDIA-SEQUENCE:122\n", result)
                self.assertIn(module.SOURCE + f"stream-{session}-24.ts\n", result)

    def test_session_id_cannot_escape_the_fixed_source_directory(self):
        for session in ["", "A" * 65, "../private", "Test.ABC", "%2e%2e", "Test?key=value", "Test#fragment", "Test\\ABC", "https://untrusted.example"]:
            with self.subTest(session=session), self.assertRaises(ValueError):
                module.live_window(playlist(session=session))

    def test_malformed_redirected_or_executable_destinations_are_refused(self):
        for text in ["", playlist().replace("stream-TestABC-24.ts", "https://untrusted.example/file"),
                     playlist().replace("stream-TestABC-24.ts", "../../private"),
                     playlist() + "#EXT-X-KEY:METHOD=AES-128,URI=private\n",
                     playlist() + "#EXT-X-ENDLIST\n", playlist() + "#EXTINF:1.0,\n", "x" * 65537]:
            with self.assertRaises(ValueError):
                module.live_window(text)

    def test_loopback_route_cannot_select_an_upstream_url_or_path(self):
        server = module.ThreadingHTTPServer(("127.0.0.1", 0), module.Handler)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        old_port = module.PORT
        module.PORT = server.server_port
        try:
            opener = Mock()
            opener.open.side_effect = lambda *args, **kwargs: io.BytesIO(playlist(session="Test-ABC_123").encode())
            with patch.object(module.urllib.request, "build_opener", return_value=opener):
                for path, host in [("/?url=http://untrusted.example", f"127.0.0.1:{module.PORT}"), ("/stream.m3u8", "untrusted.example")]:
                    connection = http.client.HTTPConnection("127.0.0.1", module.PORT, timeout=3)
                    connection.request("GET", path, headers={"Host": host})
                    response = connection.getresponse()
                    self.assertEqual(response.status, 404)
                    response.read(); connection.close()
                opener.open.assert_not_called()
                connection = http.client.HTTPConnection("127.0.0.1", module.PORT, timeout=3)
                connection.request("GET", "/stream.m3u8")
                response = connection.getresponse()
                self.assertEqual(response.status, 200)
                self.assertEqual(response.getheader("Cache-Control"), "no-store")
                self.assertEqual(response.read().decode().count("#EXTINF:"), 3)
                connection.close()
                opener.open.assert_called_once_with(module.SOURCE + "stream.m3u8", timeout=1)
        finally:
            module.PORT = old_port
            server.shutdown(); server.server_close(); thread.join(timeout=3)


class LivePlaylistSourceTests(unittest.TestCase):
    def problem(self, code):
        return urllib.error.HTTPError(module.SOURCE + "stream.m3u8", code, "test", {}, io.BytesIO())

    def source(self, results, clock=None):
        opener, pause = Mock(), Mock()
        opener.open.side_effect = results
        source = module.LivePlaylistSource(opener=opener, now=clock or (lambda: 100), pause=pause)
        return source, opener, pause

    def test_initial_transient_503_is_retried_without_ending_stream(self):
        source, opener, pause = self.source([self.problem(503), io.BytesIO(playlist().encode())])
        self.assertEqual(source.load().count(b"#EXTINF:"), 3)
        self.assertEqual(opener.open.call_count, 2)
        pause.assert_called_once_with(0.1)

    def test_cached_valid_window_survives_one_transient_refresh_error(self):
        clock = [100]
        source, opener, pause = self.source([io.BytesIO(playlist().encode()), self.problem(503), io.BytesIO(playlist(session="New-Session").encode())], lambda: clock[0])
        original = source.load()
        clock[0] = 102
        self.assertEqual(source.load(), original)
        clock[0] = 102.5
        self.assertIn(b"stream-New-Session-24.ts", source.load())
        self.assertEqual(opener.open.call_count, 3)
        pause.assert_not_called()

    def test_stale_cache_cannot_hide_an_outage_after_three_seconds(self):
        clock = [100]
        source, opener, pause = self.source([io.BytesIO(playlist().encode()), self.problem(503), self.problem(503), self.problem(503)], lambda: clock[0])
        source.load()
        clock[0] = 103.01
        with self.assertRaises(urllib.error.HTTPError):
            source.load()
        self.assertEqual(opener.open.call_count, 4)
        self.assertEqual(pause.call_count, 2)

    def test_network_failures_have_a_bounded_attempt_budget(self):
        source, opener, pause = self.source([TimeoutError(), urllib.error.URLError("temporarily unavailable"), OSError()])
        with self.assertRaises(OSError):
            source.load()
        self.assertEqual(opener.open.call_count, 3)
        self.assertEqual(pause.call_count, 2)
        self.assertTrue(all(call.kwargs == {"timeout": 1} for call in opener.open.call_args_list))

    def test_truncated_http_response_uses_only_a_recent_validated_window(self):
        source, opener, pause = self.source([io.BytesIO(playlist().encode()), http.client.IncompleteRead(b"partial", 32)])
        original = source.load()
        self.assertEqual(source.load(), original)
        self.assertEqual(opener.open.call_count, 2)
        pause.assert_not_called()

    def test_persistent_http_protocol_errors_remain_bounded(self):
        source, opener, pause = self.source([http.client.IncompleteRead(b"partial", 32), http.client.BadStatusLine("truncated"), http.client.IncompleteRead(b"partial", 32)])
        with self.assertRaises(http.client.IncompleteRead):
            source.load()
        self.assertEqual(opener.open.call_count, 3)
        self.assertEqual(pause.call_count, 2)

    def test_invalid_or_redirected_responses_never_fall_back_to_cache(self):
        invalid = playlist().replace("stream-TestABC-24.ts", "../../private")
        for problem, expected in [(io.BytesIO(invalid.encode()), ValueError), (self.problem(302), urllib.error.HTTPError), (self.problem(404), urllib.error.HTTPError), (io.BytesIO(b"x" * 65537), ValueError)]:
            with self.subTest(expected=expected):
                source, opener, pause = self.source([io.BytesIO(playlist().encode()), problem])
                source.load()
                with self.assertRaises(expected):
                    source.load()
                self.assertEqual(opener.open.call_count, 2)
                pause.assert_not_called()


if __name__ == "__main__":
    unittest.main()
