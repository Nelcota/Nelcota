"""Prepare the exact fixture image set on an otherwise empty disposable VM."""
import json
import re

from campaign import docker
from ingress import CADDY

IMAGES = ('ubuntu:24.04', 'postgres:17-alpine', CADDY)


def prepare_images(call):
    result = []
    for image in IMAGES:
        cached = True
        try:
            raw = call('image', 'inspect', image)
        except RuntimeError as error:
            if 'No such image' not in str(error):
                raise
            cached = False
            call('pull', image)
            raw = call('image', 'inspect', image)
        values = json.loads(raw)
        if not isinstance(values, list) or len(values) != 1:
            raise ValueError('Missing unique browser fixture image')
        value = values[0]
        identifier, digests, size = [value.get(key) for key in ['Id', 'RepoDigests', 'Size']]
        repository = image.split(':', 1)[0]
        if (not isinstance(identifier,str) or re.fullmatch('sha256:[a-f0-9]{64}',identifier) is None
                or not isinstance(digests,list) or not 1 <= len(digests) <= 4
                or any(not isinstance(item,str) or re.fullmatch(re.escape(repository) + '@sha256:[a-f0-9]{64}',item) is None for item in digests)
                or type(size) is not int or not 0 < size <= 512 * 1024 ** 2):
            raise ValueError('Invalid immutable browser fixture image metadata')
        result.append({'image':image, 'was_cached':cached, 'id':identifier, 'repo_digests':digests, 'size_bytes':size})
    return result


if __name__ == '__main__':
    print('::notice title=Browser fixture image preflight::' + json.dumps({
        'scope':'Explicit disposable fixture preparation before any measured traffic; no load-time credit',
        'images':prepare_images(docker)}, separators=(',', ':'), allow_nan=False))
