import contextlib
import io
import json
import sys
import tempfile
import unittest
from unittest.mock import Mock, patch

import start_instagram_browser as launcher


class BrowserLauncherTests(unittest.TestCase):
    def run_launcher(self, opener, process, port_busy=False):
        with tempfile.TemporaryDirectory() as tmp, \
             patch.object(launcher, '__file__', tmp + '/start.py'), \
             patch.object(sys, 'argv', ['start.py']), \
             patch.object(launcher, 'browser_path', return_value=sys.executable), \
             patch.object(launcher.socket, 'socket') as socket, \
             patch.object(launcher, 'build_opener', return_value=opener), \
             patch.object(launcher.subprocess, 'Popen', return_value=process) as spawn, \
             contextlib.redirect_stdout(io.StringIO()) as output, \
             contextlib.redirect_stderr(io.StringIO()):
            socket.return_value.__enter__.return_value.connect_ex.return_value = 1
            result = launcher.main()
            return result, output.getvalue(), spawn

    def test_reports_success_only_after_page_exists(self):
        opener = Mock()
        opener.open.return_value = io.BytesIO(json.dumps([{'type': 'page'}]).encode())
        result, output, spawn = self.run_launcher(opener, Mock())
        self.assertEqual(result, 0)
        self.assertIn('已启动', output)
        self.assertTrue(spawn.call_args.kwargs['start_new_session'])

    def test_early_exit_does_not_report_success(self):
        opener = Mock()
        opener.open.side_effect = OSError('not ready')
        process = Mock(returncode=1)
        process.poll.return_value = 1
        result, output, _ = self.run_launcher(opener, process)
        self.assertEqual(result, 1)
        self.assertNotIn('已启动', output)
