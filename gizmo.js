import * as THREE from "https://esm.sh/three";
import { OrbitControls } from "https://esm.sh/three/examples/jsm/controls/OrbitControls";
import * as BufferGeometryUtils from 'https://esm.sh/three/addons/utils/BufferGeometryUtils.js';

let scene, camera, renderer, controls;
let gizmo, selectedAxis = null;
const raycaster = new THREE.Raycaster();
const mouse = new THREE.Vector2();

var maxGizmoMoveDistance = 50;
var usePerspective = true;


init();
animate();

function init() {
    // Constants
    const fov = 50; // Field of view for perspective camera
    const aspect = window.innerWidth / window.innerHeight;

    // Perspective camera near and far planes
    const nearPerspective = 0.1;
    const farPerspective = 1000;

    // Orthographic camera near and far planes
    const nearOrtho = -1000;
    const farOrtho = 1000;

    // Scene setup
    scene = new THREE.Scene();
    scene.background = new THREE.Color(0x333333);

    // Camera setup
    if (usePerspective) {
        // Perspective Camera
        camera = new THREE.PerspectiveCamera(fov, aspect, nearPerspective, farPerspective);
    } else {
        // Orthographic Camera
        const frustumSize = 10;
        const halfWidth = frustumSize * aspect / 2;
        const halfHeight = frustumSize / 2;
        camera = new THREE.OrthographicCamera(
            -halfWidth, halfWidth, halfHeight, -halfHeight, nearOrtho, farOrtho
        );
    }

    camera.position.set(3, 3, 3);

    // Renderer setup
    renderer = new THREE.WebGLRenderer();
    renderer.setSize(window.innerWidth, window.innerHeight);
    document.body.appendChild(renderer.domElement);

    // Orbit Controls
    controls = new OrbitControls(camera, renderer.domElement);

    // Add lighting
    const light = new THREE.DirectionalLight(0xffffff, 1);
    light.position.set(5, 5, 5);
    scene.add(light);
    scene.add(new THREE.AmbientLight(0x404040));

    // Create grid helper
    const gridHelper = new THREE.GridHelper(10, 10);
    scene.add(gridHelper);

    // Create gizmo
    gizmo = createGizmo();
    scene.add(gizmo);

    // Event listeners for interaction
    window.addEventListener('mousedown', onMouseDown);
    window.addEventListener('mousemove', onMouseMove);
    window.addEventListener('mouseup', onMouseUp);
    window.addEventListener('resize', onWindowResize);
}



function createGizmo() {
    const gizmo = new THREE.Group();

    // Materials for the axis handlers
    const materialX = new THREE.MeshBasicMaterial({ color: 0xff0000, opacity: 0.8, transparent: true });
    const materialY = new THREE.MeshBasicMaterial({ color: 0x00ff00, opacity: 0.8, transparent: true });
    const materialZ = new THREE.MeshBasicMaterial({ color: 0x0000ff, opacity: 0.8, transparent: true });

    // Materials for the plane handles (double-sided visibility)
    const planeMaterialXY = new THREE.MeshBasicMaterial({ color: 0xffff00, opacity: 0.5, transparent: true, side: THREE.DoubleSide });
    const planeMaterialXZ = new THREE.MeshBasicMaterial({ color: 0xff00ff, opacity: 0.5, transparent: true, side: THREE.DoubleSide });
    const planeMaterialYZ = new THREE.MeshBasicMaterial({ color: 0x00ffff, opacity: 0.5, transparent: true, side: THREE.DoubleSide });

    const axisHandleLength = 1.5;
    const axisHandleRadius = 0.05;
    const coneHeight = 0.3;
    const coneRadius = 0.1;

    const numSides = 16;

    const cylinderGeometry = new THREE.CylinderGeometry(axisHandleRadius, axisHandleRadius, axisHandleLength, numSides);
    const coneGeometry = new THREE.ConeGeometry(coneRadius, coneHeight, numSides);
    const planeGeometry = new THREE.PlaneGeometry(0.5, 0.5);

    // Utility function to create a combined mesh for an axis
    function createAxisMesh(cylinderGeom, coneGeom, material, axis) {
        // Position the cone at the end of the cylinder
        coneGeom.translate(0, axisHandleLength+coneHeight/2, 0); // Move cone above the cylinder's top
        cylinderGeom.translate(0, axisHandleLength / 2, 0); // Align cylinder with center

        // Merge the cylinder and cone geometries
        const mergedGeometry = BufferGeometryUtils.mergeGeometries([cylinderGeom, coneGeom]);

        const mesh = new THREE.Mesh(mergedGeometry, material);
        mesh.userData.axis = axis; // Enable interactivity
        return mesh;
    }

    // X-axis
    const axisX = createAxisMesh(
        cylinderGeometry.clone(),
        coneGeometry.clone(),
        materialX,
        "x"
    );
    axisX.rotation.z = -Math.PI / 2;
    axisX.position.x = 0;
    gizmo.add(axisX);

    // Y-axis
    const axisY = createAxisMesh(
        cylinderGeometry.clone(),
        coneGeometry.clone(),
        materialY,
        "y"
    );
    axisY.position.y = 0;
    gizmo.add(axisY);

    // Z-axis
    const axisZ = createAxisMesh(
        cylinderGeometry.clone(),
        coneGeometry.clone(),
        materialZ,
        "z"
    );
    axisZ.rotation.x = Math.PI / 2;
    axisZ.position.z = 0;
    gizmo.add(axisZ);

    // Add square handles for planes
    const xyHandle = new THREE.Mesh(planeGeometry, planeMaterialXY);
    xyHandle.position.set(0.25, 0.25, 0); // Positioned for XY plane
    xyHandle.rotation.z = 0; // Correct rotation for XY plane
    xyHandle.userData.axis = "xy"; // Correct axis for XY plane
    gizmo.add(xyHandle);

    const xzHandle = new THREE.Mesh(planeGeometry, planeMaterialXZ);
    xzHandle.position.set(0.25, 0, 0.25); // Positioned for XZ plane
    xzHandle.rotation.x = -Math.PI / 2; // Correct rotation for XZ plane
    xzHandle.userData.axis = "xz"; // Correct axis for XZ plane
    gizmo.add(xzHandle);

    const yzHandle = new THREE.Mesh(planeGeometry, planeMaterialYZ);
    yzHandle.position.set(0, 0.25, 0.25); // Positioned for YZ plane
    yzHandle.rotation.y = Math.PI / 2; // Correct rotation for YZ plane
    yzHandle.userData.axis = "yz"; // Correct axis for YZ plane
    gizmo.add(yzHandle);

    return gizmo;
}

let initialOffset = new THREE.Vector3(); // Offset to prevent jumping


function onMouseDown(event) {
    mouse.x = (event.clientX / window.innerWidth) * 2 - 1;
    mouse.y = -(event.clientY / window.innerHeight) * 2 + 1;

    if (camera.isPerspectiveCamera) {
        raycaster.setFromCamera(mouse, camera);
    } else if (camera.isOrthographicCamera) {
        const origin = new THREE.Vector3(mouse.x, mouse.y, -1).unproject(camera);
        const direction = new THREE.Vector3(0, 0, -1).transformDirection(camera.matrixWorld);
        raycaster.set(origin, direction);
    }

    const intersects = raycaster.intersectObjects(gizmo.children, false);

    if (intersects.length > 0) {
        selectedAxis = intersects[0].object.userData.axis;
        controls.enabled = false; // Disable orbit controls during dragging

        // Calculate the initial offset for smooth dragging
        const plane = new THREE.Plane();
        const planeNormal = new THREE.Vector3();

        if (selectedAxis === "x") planeNormal.set(0, 1, 0);
        else if (selectedAxis === "y") planeNormal.set(1, 0, 0);
        else if (selectedAxis === "z") planeNormal.set(0, 1, 0);
        else if (selectedAxis === "xy") planeNormal.set(0, 0, 1);
        else if (selectedAxis === "xz") planeNormal.set(0, 1, 0);
        else if (selectedAxis === "yz") planeNormal.set(1, 0, 0);

        plane.setFromNormalAndCoplanarPoint(planeNormal, gizmo.position);

        const intersect = raycaster.ray.intersectPlane(plane, new THREE.Vector3());
        if (intersect) {
            initialOffset.copy(intersect).sub(gizmo.position);
        }
    }
}

function onMouseUp() {
    selectedAxis = null;
    controls.enabled = true; // Re-enable orbit controls
}

function onMouseMove(event) {
    if (!selectedAxis) return;

    mouse.x = (event.clientX / window.innerWidth) * 2 - 1;
    mouse.y = -(event.clientY / window.innerHeight) * 2 + 1;

    if (camera.isPerspectiveCamera) {
        // For perspective camera
        raycaster.setFromCamera(mouse, camera);
    } else if (camera.isOrthographicCamera) {
        // For orthographic camera
        const origin = new THREE.Vector3(mouse.x, mouse.y, -1).unproject(camera);
        const direction = new THREE.Vector3(0, 0, -1).transformDirection(camera.matrixWorld);
        raycaster.set(origin, direction);
    }

    const plane = new THREE.Plane();
    const planeNormal = new THREE.Vector3();

    if (selectedAxis === "x") {
        planeNormal.set(0, 1, 0); // Perpendicular to the X-axis
    } else if (selectedAxis === "y") {
        planeNormal.set(1, 0, 0); // Perpendicular to the Y-axis
    } else if (selectedAxis === "z") {
        planeNormal.set(0, 1, 0); // Perpendicular to the Z-axis
    } else if (selectedAxis === "xy") {
        planeNormal.set(0, 0, 1); // Perpendicular to the XY plane
    } else if (selectedAxis === "xz") {
        planeNormal.set(0, 1, 0); // Perpendicular to the XZ plane
    } else if (selectedAxis === "yz") {
        planeNormal.set(1, 0, 0); // Perpendicular to the YZ plane
    }

    plane.setFromNormalAndCoplanarPoint(planeNormal, gizmo.position);

    const intersect = raycaster.ray.intersectPlane(plane, new THREE.Vector3());
    if (!intersect) return;

    const adjustedIntersect = intersect.sub(initialOffset);

    const worldMovement = new THREE.Vector3();
    if (selectedAxis === "x") {
        worldMovement.set(adjustedIntersect.x - gizmo.position.x, 0, 0);
    } else if (selectedAxis === "y") {
        worldMovement.set(0, adjustedIntersect.y - gizmo.position.y, 0);
    } else if (selectedAxis === "z") {
        worldMovement.set(0, 0, adjustedIntersect.z - gizmo.position.z);
    } else if (selectedAxis === "xy") {
        worldMovement.set(adjustedIntersect.x - gizmo.position.x, adjustedIntersect.y - gizmo.position.y, 0);
    } else if (selectedAxis === "xz") {
        worldMovement.set(adjustedIntersect.x - gizmo.position.x, 0, adjustedIntersect.z - gizmo.position.z);
    } else if (selectedAxis === "yz") {
        worldMovement.set(0, adjustedIntersect.y - gizmo.position.y, adjustedIntersect.z - gizmo.position.z);
    }

    // Check the distance to the camera after applying movement
    const proposedPosition = gizmo.position.clone().add(worldMovement);
    const distanceToCamera = proposedPosition.distanceTo(camera.position);

    // Apply movement only if within the allowed distance
    if (distanceToCamera <= maxGizmoMoveDistance) {
        gizmo.position.add(worldMovement);
    }
}



function onWindowResize() {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
}

function animate() {
    requestAnimationFrame(animate);

    renderer.render(scene, camera);
}

