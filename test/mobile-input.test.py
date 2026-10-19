import importlib.util
import pathlib
import unittest
import http.client
import io
import threading
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
        self.assertIn("http://127.0.0.1:8080/hls/0/stream-TestABC-24.ts", result)

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
                opener.open.assert_called_once_with(module.SOURCE + "stream.m3u8", timeout=3)
        finally:
            module.PORT = old_port
            server.shutdown(); server.server_close(); thread.join(timeout=3)


if __name__ == "__main__":
    unittest.main()
