"""Cold-cache setup cannot silently depend on earlier local Docker pulls."""
import json
from pathlib import Path
import sys
import unittest

sys.path.insert(0,str(Path(__file__).resolve().parents[2]/'bench'))
from browser_images import IMAGES, prepare_images


def image_metadata(image):
    return json.dumps([{'Id':'sha256:'+'a'*64, 'RepoDigests':[image.split(':',1)[0]+'@sha256:'+'b'*64],
                        'Size':1024, 'Config':{'Env':['PRIVATE_TOKEN=private-token']}}])


class BrowserFixtureImages(unittest.TestCase):
    def test_cold_cache_pulls_each_missing_required_image_once(self):
        cached=set();pulls=[]
        def call(*args):
            if args[0]=='pull':
                pulls.append(args[1]);cached.add(args[1]);return ''
            if args[-1] not in cached:
                raise RuntimeError('Docker operation failed: image No such image')
            return image_metadata(args[-1])
        proof=prepare_images(call)
        self.assertEqual(pulls,list(IMAGES))
        self.assertTrue(all(not item['was_cached'] for item in proof))
        self.assertNotIn('private-token',str(proof))

    def test_warm_cache_does_not_repeat_pull_mutations(self):
        def call(*args):
            self.assertEqual(args[:2],('image','inspect'))
            return image_metadata(args[-1])
        self.assertTrue(all(item['was_cached'] for item in prepare_images(call)))

    def test_daemon_errors_are_not_retried_as_missing_images(self):
        calls=[]
        def call(*args):
            calls.append(args);raise RuntimeError('Docker daemon permission denied private-token')
        with self.assertRaises(RuntimeError):prepare_images(call)
        self.assertEqual(len(calls),1)

    def test_invalid_or_unpinned_metadata_cannot_complete_preflight(self):
        for change in [{'Id':'unknown'},{'RepoDigests':[]},{'RepoDigests':['private.invalid@sha256:'+'b'*64]},
                       {'Size':True},{'Size':513*1024**2}]:
            def call(*args):
                value=json.loads(image_metadata(args[-1]));value[0].update(change);return json.dumps(value)
            with self.subTest(change=change),self.assertRaises(ValueError):prepare_images(call)

    def test_failed_pull_cannot_be_hidden_by_an_inferred_image(self):
        calls=[]
        def call(*args):
            calls.append(args)
            if args[0]=='pull':raise RuntimeError('Registry unavailable')
            raise RuntimeError('Docker operation failed: image No such image')
        with self.assertRaises(RuntimeError):prepare_images(call)
        self.assertEqual(len(calls),2)
