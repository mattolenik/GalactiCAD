"""Expand the lossless probe-column encoding. No geometry is evaluated."""
import copy
import json
import sys
from pathlib import Path

FIELDS = ['deltaHex', 'displacementHex', 'domain', 'firstPredicate', 'fullResidualHex', 'level', 'normalErrorHex', 'oppositeResidualHex', 'ownResidualHex', 'pointHex', 'sign']

def expand(compact):
    assert compact['encoding'] == 'sfcc-junction-c-columnar-attempts-v1'
    assert compact['attemptFields'] == FIELDS
    evidence = copy.deepcopy(compact['evidence'])
    for query in evidence['queries']:
        if query['flanks'] is None:
            continue
        for flank in query['flanks']:
            rows = []
            for row in flank['attempts']:
                assert isinstance(row, list) and len(row) == len(FIELDS)
                rows.append(dict(zip(FIELDS, row)))
            flank['attempts'] = rows
    return evidence

if __name__ == '__main__':
    if len(sys.argv) != 3:
        raise SystemExit('usage: expand.py INPUT.json OUTPUT.json')
    result = expand(json.loads(Path(sys.argv[1]).read_text()))
    Path(sys.argv[2]).write_text(json.dumps(result, sort_keys=True, indent=2) + '\n')
