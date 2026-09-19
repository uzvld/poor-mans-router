"""OMP JSONL input and bounded protocol-2 output decoding."""
import base64
import json

FRAME = 1048576
TOTAL = 64 * FRAME
CHUNK = 262144

def encode_input(obj):
    if not isinstance(obj, dict):
        raise ValueError('input must be an object')
    wire = (json.dumps(obj, ensure_ascii=False, allow_nan=False) + '\n').encode('utf-8')
    if len(wire) > FRAME:
        raise ValueError('input exceeds JSONL limit; inbound chunking is unsupported')
    return wire

class Decoder:
    def __init__(self):
        self.buffer = bytearray()
        self.pending = None

    def feed(self, data):
        self.buffer.extend(data)
        output = []
        while (end := self.buffer.find(b'\n')) >= 0:
            if end + 1 > FRAME:
                raise ValueError('frame limit exceeded')
            line = bytes(self.buffer[:end])
            del self.buffer[:end+1]
            if not line.strip():
                continue
            obj = json.loads(line.decode('utf-8'))
            if not isinstance(obj, dict):
                raise ValueError('frame must be an object')
            if obj.get('type') == 'rpc_chunk':
                obj = self._chunk(obj)
            elif self.pending:
                raise ValueError('interrupted chunk sequence')
            if obj is not None:
                output.append(obj)
        if len(self.buffer) >= FRAME:
            raise ValueError('partial frame limit exceeded')
        return output

    def _chunk(self, obj):
        ident, index, count, length = (obj.get(k) for k in ('chunkId', 'index', 'count', 'byteLength'))
        if (not isinstance(ident, str) or not 0 < len(ident) <= 128
            or any(type(n) is not int for n in (index, count, length))
            or not 2 <= count <= TOTAL // CHUNK or not 0 <= index < count
            or not FRAME <= length <= TOTAL):
            raise ValueError('invalid chunk metadata')
        encoded = obj.get('data')
        if not isinstance(encoded, str) or not encoded:
            raise ValueError('missing chunk data')
        raw = base64.b64decode(encoded, validate=True)
        if len(raw) > CHUNK or base64.b64encode(raw).decode() != encoded:
            raise ValueError('invalid chunk encoding')
        if self.pending is None:
            self.pending = [ident, 0, count, length, bytearray()]
        p = self.pending
        if p[:4] != [ident, index, count, length]:
            raise ValueError('chunk sequence mismatch')
        p[4].extend(raw); p[1] += 1
        if len(p[4]) > length:
            raise ValueError('chunk length exceeded')
        if p[1] != count:
            return None
        if len(p[4]) != length:
            raise ValueError('chunk length mismatch')
        result = json.loads(p[4].decode('utf-8'))
        if not isinstance(result, dict) or result.get('type') == 'rpc_chunk':
            raise ValueError('invalid reassembled object')
        self.pending = None
        return result

    def finish(self):
        if self.buffer.strip() or self.pending is not None:
            raise ValueError('truncated output at EOF')
