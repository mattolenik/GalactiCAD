This is an in-browser CAD application that uses SDFs (signed distance functions) for representing geometry instead of
polygons. It uses WebGPU and the WGSL shading language for rendering SDFs. It is a CAD-as-code design, similar in
concept to OpenSCAD.

The CAD models are defined by JavaScript code that the user edits in-app using the Monaco code
editor. The code should be an expression or block that eventually returns a Node object, which is a scene object such
as a Sphere, Cube, Union, or other construct. This source will be loaded into a Function object and executed, giving a
scene tree. The scene tree that results will be walked and evaluated and the result is a string that contains the WGSL
code for rendering the SDF scene, which will then be injected into the shader code at runtime.

Rendering is done with ray marching in preview.wgsl and related files. Keep in mind all rendering is done manually with
this fragment shader, so no traditional rendering techniques with polygons will work, we must handle it all.

When doing shader programming, remember that this is WebGPU and so the language is WGSL, not HLSL or GLSL. Keep in mind the syntactic and semantic differences between WGSL and other shading languages.
