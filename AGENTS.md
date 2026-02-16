This is an in-browser CAD application that uses SDFs (signed distance functions) for representing geometry instead of
polygons. It uses WebGPU and the WGSL shading language for rendering SDFs. It is a CAD-as-code design, similar in
concept to OpenSCAD.

The CAD models are defined by JavaScript code that the user edits in-app using the Monaco code
editor. The code should be an expression or block that eventually returns a Node object, which is a scene object such
as a Sphere, Cube, Union, or other construct. This source will be loaded into a Function object and executed, giving a
scene tree. The scene tree that results will be walked and evaluated and the result is a string that contains the WGSL
code for rendering the SDF scene, which will then be injected into the shader code at runtime.

## Notes on Rendering

Rendering is done with ray marching in preview.wgsl and related files. Keep in mind all rendering is done manually with
this fragment shader, so no traditional rendering techniques with polygons will work, we must handle it all.

## Shader Programming Tips

When doing shader programming, remember that this is WebGPU and so the language is WGSL, not HLSL or GLSL. Keep in mind
the syntactic and semantic differences between WGSL and other shading languages.

This project uses an esbuild plugin to transform wgsl shader files at compile time (build/wgsl-loader.mts). It allows you
to import the shader code as a string in TypeScript, and it can perform some preprocessing as well. Namely, it creates
a C-style include which uses the following syntax:

//:) include "hg_sdf.wgsl"

That would insert hg_sdf.wgsl into the file, similar to a C include.

A shader can be loaded into TypeScript like this:

import previewShader from "./shaders/preview.wgsl"

That results in previewShader being a string with the processed content of the code.

## Building and Linting

See `.cursor/rules/build-commands.mdc` for build/test command rules.

- **Build**: `make build`
- **Test**: `make test`

**Do not run build or lint commands on WGSL files directly.** WGSL files will be compiled with `make build` by the custom build logic. This means when making changes to WGSL files, you should run `make build` to validate them. If they don't compile, you will see the compiler error in `make build`. This custom build logic is what handles the `//:) include` directive, meaning this shader compiler output is indicative of what happens at runtime.
