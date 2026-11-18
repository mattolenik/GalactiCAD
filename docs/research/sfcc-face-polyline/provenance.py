"""Bind the entire two-segment fixture to original FaceRecords and emitted consumers.
No source evaluation or continuous-geometry theorem is supplied by this checker.
"""
from pathlib import Path
import copy
import hashlib
import json
import sys


def require(condition, reason):
    if not condition:
        raise ValueError(reason)


def normalize(value):
    if isinstance(value, dict):
        return {k: normalize(v) for k, v in value.items() if k != 'rootAddressProcessLocal'}
    if isinstance(value, list):
        return [normalize(v) for v in value]
    return value


def unique(rows, key):
    result = {row[key]: row for row in rows}
    require(len(result) == len(rows), 'duplicate_rows')
    return result


def directed_count(sequence, edge):
    return sum([sequence[i], sequence[(i + 1) % len(sequence)]] == edge for i in range(len(sequence)))


def bind(runtime, fixture, incident):
    outside = runtime['outsideB']
    target = outside['pairedTargetA']
    second = outside['secondSegmentB']
    first = outside['pairedFanBindingA']
    face = fixture['face']
    require(face == [0, 3464532, 2] == target['face'] == second['face'], 'face_identity')
    require(outside['originalFaceConsumptionValid'] and first['complete'] and second['complete'], 'consumers_not_validated')
    rows = [r for r in outside['faces'] if r['face'] == face]
    require(len(rows) == 1, 'original_face_count')
    row = rows[0]
    require(not row['interiorCycle'] and row['consumedForward'] == [0, 0] and row['consumedReverse'] == [0, 0], 'original_face_state')
    require(row['segments'] == target['originalSegments'] == second['originalSegments'] == [[4072, 4074], [4074, 4073]], 'entire_original_segment_inventory')
    require(normalize(fixture['originalTarget']) == normalize(target), 'target_provenance')
    require(target['consumers'] == second['consumers'] == [[[7,25,58,86],1,True],[[7,26,58,86],0,False]], 'opposite_consumers')
    require(fixture['sourceFingerprint'] == incident['sourceFingerprint'] == outside['sourceFingerprint'] == second['sourceFingerprint'], 'source_fingerprint')
    require(row['pins'] == [[49, 4629807001818732852, 4074]], 'original_pin_inventory')
    pins = target['originalPins']
    require(len(pins) == 1 and pins == second['originalPins'], 'pin_consumer_binding')
    pin = pins[0]
    require([pin['chart'], pin['parameterBits'], pin['originalPoint']] == row['pins'][0]
            and pin['candidatePoint'] == 40 and pin['strata'] == [31,15], 'pin_source_binding')
    global_to_local = dict(outside['pointBindings'])
    require(len(global_to_local) == len(outside['pointBindings']), 'global_local_duplicates')
    joined = outside['joined']['outsideToJoined']
    require(joined == fixture['outsideToJoined'], 'joined_mapping')
    candidate = unique(runtime['candidateInventory']['points'], 'id')
    local = unique(outside['points'], 'id')
    fp = unique(fixture['points'], 'id')
    ip = unique(incident['points'], 'id')
    binding = {}
    for global_id, joined_id in [(4072,38),(4073,39),(4074,40)]:
        local_id = global_to_local[global_id]
        require(joined[local_id] == joined_id, 'point_id_binding')
        bits = [int(v,16) for v in candidate[joined_id]['positionHex']]
        require(bits == local[local_id]['positionBits'] == fp[joined_id]['positionBits'] == ip[joined_id]['positionBits'], 'point_bits')
        require(candidate[joined_id]['key'] == local[local_id]['key'] and candidate[joined_id]['key'] != 'Unkeyed', 'point_key')
        binding[global_id] = joined_id
    segments = [[binding[a], binding[b]] for a,b in row['segments']]
    require(segments == [[38,40],[40,39]], 'whole_polyline')
    require(fixture['sharedSegments'] == incident['sharedSegments'] == [[40,38],[39,40]], 'fixture_segments')
    require(fixture['commonEndpoint'] == incident['commonEndpoint'] == 40, 'fixture_join')
    pairs = [(outside['pairedCandidateFanA'],first['joinedFan'],[40,38],0,1),
             (second['insideFan'],second['outsideJoinedFan'],[39,40],2,3)]
    for inside_fan, outside_fan, edge, fi, fo in pairs:
        for fan, directed, fixture_index in [(inside_fan,edge,fi),(outside_fan,edge[::-1],fo)]:
            expected = fixture['patches'][fixture_index]
            require(fan['boundary'] == expected['boundary'] and fan['triangles'] == expected['triangles']
                    and fan['hypothesisStratum'] == expected['hypothesisStratum'], 'fan_fixture_binding')
            incident_fans = [p for p in incident['patches'] if p['triangles'] == fan['triangles'] and p['boundary'] == fan['boundary']]
            require(len(incident_fans) == 1 and normalize(incident_fans[0]['sourceIdentity']) == normalize(fan['sourceIdentity']), 'fan_source_identity')
            require(directed_count(fan['boundary'], directed) == 1, 'fan_boundary_direction')
            triangles = fan['triangles']
            require(len(triangles) % 3 == 0, 'triangle_encoding')
            count = sum(directed_count(triangles[i:i+3], directed) for i in range(0,len(triangles),3))
            reverse = sum(directed_count(triangles[i:i+3], directed[::-1]) for i in range(0,len(triangles),3))
            require(count == 1 and reverse == 0, 'emitted_edge_direction')
            for point in fan['points']:
                require(point['positionBits'] == fp[point['id']]['positionBits'] == ip[point['id']]['positionBits'], 'fan_point_bits')
    require(normalize(outside['incidentA']['cells']) == normalize(incident['cells'])
            and normalize(outside['incidentA']['points']) == normalize(incident['points'])
            and normalize(outside['incidentA']['patches']) == normalize(incident['patches']), 'whole_incident_geometry')
    return {'completeOriginalFaceSegmentInventoryBound': True,
            'originalSegmentCount': 2, 'originalPinCount': 1,
            'globalToJoined': [[k,v] for k,v in binding.items()],
            'orderedJoinedPolyline': [39,40,38],
            'oppositeEmittedFanDirectionsBound': True,
            'allThreePointKeysAndBitsBound': True,
            'wholeIncidentTriangleAndFanGeometryBound': True,
            'continuousSourceOrCoverageProofSuppliedHere': False,
            'scope': 'discrete original-record and emitted-consumer provenance only; compose with fresh continuous source theorem'}


def controls(runtime, fixture, incident):
    cases = []
    r = copy.deepcopy(runtime); r['outsideB']['faces'].append(copy.deepcopy(next(v for v in r['outsideB']['faces'] if v['face']==fixture['face']))); cases.append(('duplicate_original_face',r))
    r = copy.deepcopy(runtime); next(v for v in r['outsideB']['faces'] if v['face']==fixture['face'])['segments'].append([4072,4073]); cases.append(('extra_original_segment',r))
    r = copy.deepcopy(runtime); r['outsideB']['joined']['outsideToJoined'][0] = 39; cases.append(('wrong_joined_mapping',r))
    r = copy.deepcopy(runtime); r['outsideB']['points'][0]['positionBits'][2] ^= 1; cases.append(('one_bit_point_mutation',r))
    r = copy.deepcopy(runtime); r['outsideB']['secondSegmentB']['outsideJoinedFan']['triangles'][0:3] = r['outsideB']['secondSegmentB']['outsideJoinedFan']['triangles'][0:3][::-1]; cases.append(('reversed_emitted_triangle',r))
    r = copy.deepcopy(runtime); r['outsideB']['secondSegmentB']['outsideJoinedFan']['sourceIdentity']['id'] = 15; cases.append(('wrong_source_identity',r))
    rejected = []
    for name, changed in cases:
        try:
            bind(changed,fixture,incident)
        except (ValueError,KeyError,IndexError) as error:
            rejected.append({'case':name,'refusal':str(error)})
        else:
            raise AssertionError('accepted corrupted provenance: '+name)
    return rejected


if __name__ == '__main__':
    require(len(sys.argv) == 5, 'usage: runtime.json face-fans-c.json incident-union-c.json output.json')
    paths = [Path(v) for v in sys.argv[1:4]]
    inputs = [json.loads(p.read_text()) for p in paths]
    report = {'inputs':[{'path':str(p),'sha256':hashlib.sha256(p.read_bytes()).hexdigest()} for p in paths],
              'result':bind(*inputs), 'negativeControls':controls(*inputs),
              'newSourceOrGeometryEvaluations':0}
    Path(sys.argv[4]).write_text(json.dumps(report,indent=2)+'\n')
    print(json.dumps(report['result']))
