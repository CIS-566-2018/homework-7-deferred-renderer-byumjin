import {mat4, vec4, vec3} from 'gl-matrix';
import Drawable from './Drawable';
import Camera from '../../Camera';
import {gl} from '../../globals';
import ShaderProgram, {Shader} from './ShaderProgram';
import PostProcess from './PostProcess'
import Square from '../../geometry/Square';


class OpenGLRenderer {
  gBuffer: WebGLFramebuffer; // framebuffer for deferred rendering

  gbTargets: WebGLTexture[]; // references to different 4-channel outputs of the gbuffer
                             // Note that the constructor of OpenGLRenderer initializes
                             // gbTargets[0] to store 32-bit values, while the rest
                             // of the array stores 8-bit values. You can modify
                             // this if you want more 32-bit storage.

  depthTexture: WebGLTexture; // You don't need to interact with this, it's just
                              // so the OpenGL pipeline can do depth sorting

  // post-processing buffers pre-tonemapping (32-bit color)
  post32Buffers: WebGLFramebuffer[];
  post32Targets: WebGLTexture[];

  // post-processing buffers post-tonemapping (8-bit color)
  post8Buffers: WebGLFramebuffer[];
  post8Targets: WebGLTexture[];

  // post processing shader lists, try to limit the number for performance reasons
  post8Passes: PostProcess[];
  post32Passes: PostProcess[];

  currentTime: number; // timer number to apply to all drawing shaders

  // the shader that renders from the gbuffers into the postbuffers
  deferredShader :  PostProcess = new PostProcess(
    new Shader(gl.FRAGMENT_SHADER, require('../../shaders/deferred-render.glsl'))
    );

  // shader that maps 32-bit color to 8-bit color
  tonemapPass : PostProcess = new PostProcess(
    new Shader(gl.FRAGMENT_SHADER, require('../../shaders/tonemap-frag.glsl'))
    );


  add8BitPass(pass: PostProcess) {
    this.post8Passes.push(pass);
  }


  add32BitPass(pass: PostProcess) {
    this.post32Passes.push(pass);
  }


  constructor(public canvas: HTMLCanvasElement) {
    this.currentTime = 0.0;
    this.gbTargets = [undefined, undefined, undefined];
    this.post8Buffers = [undefined, undefined];
    this.post8Targets = [undefined, undefined];
    this.post8Passes = [];

    this.post32Buffers = [undefined, undefined];
    this.post32Targets = [undefined, undefined];
    this.post32Passes = [];

    // TODO: these are placeholder post shaders, replace them with something good
    this.add8BitPass(new PostProcess(new Shader(gl.FRAGMENT_SHADER, require('../../shaders/examplePost-frag.glsl'))));
    this.add8BitPass(new PostProcess(new Shader(gl.FRAGMENT_SHADER, require('../../shaders/examplePost2-frag.glsl'))));

    this.add32BitPass(new PostProcess(new Shader(gl.FRAGMENT_SHADER, require('../../shaders/examplePost3-frag.glsl'))));

    if (!gl.getExtension("OES_texture_float_linear")) {
      console.error("OES_texture_float_linear not available");
    }

    if (!gl.getExtension("EXT_color_buffer_float")) {
      console.error("FLOAT color buffer not available");
    }

    var gb0loc = gl.getUniformLocation(this.deferredShader.prog, "u_gb0");
    var gb1loc = gl.getUniformLocation(this.deferredShader.prog, "u_gb1");
    var gb2loc = gl.getUniformLocation(this.deferredShader.prog, "u_gb2");

    this.deferredShader.use();
    gl.uniform1i(gb0loc, 0);
    gl.uniform1i(gb1loc, 1);
    gl.uniform1i(gb2loc, 2);
  }


  setClearColor(r: number, g: number, b: number, a: number) {
    gl.clearColor(r, g, b, a);
  }


  setSize(width: number, height: number) {
    console.log(width, height);
    this.canvas.width = width;
    this.canvas.height = height;

    // --- GBUFFER CREATION START ---
    // refresh the gbuffers
    this.gBuffer = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.gBuffer);
    gl.drawBuffers([gl.COLOR_ATTACHMENT0, gl.COLOR_ATTACHMENT1, gl.COLOR_ATTACHMENT2]);

    for (let i = 0; i < this.gbTargets.length; i ++) {
      this.gbTargets[i] = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, this.gbTargets[i]);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

      if (i == 0) {
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA32F, gl.drawingBufferWidth, gl.drawingBufferHeight, 0, gl.RGBA, gl.FLOAT, null);
      }
      else {
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, gl.drawingBufferWidth, gl.drawingBufferHeight, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
      }

      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0 + i, gl.TEXTURE_2D, this.gbTargets[i], 0);
    }
    // depth attachment
    this.depthTexture = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, this.depthTexture);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.DEPTH_COMPONENT32F, gl.drawingBufferWidth, gl.drawingBufferHeight, 0, gl.DEPTH_COMPONENT, gl.FLOAT, null);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.TEXTURE_2D, this.depthTexture, 0);

    var FBOstatus = gl.checkFramebufferStatus(gl.FRAMEBUFFER);
    if (FBOstatus != gl.FRAMEBUFFER_COMPLETE) {
        console.error("GL_FRAMEBUFFER_COMPLETE failed, CANNOT use FBO[0]\n");
    }

    gl.bindFramebuffer(gl.FRAMEBUFFER, null);

    // create the framebuffers for post processing
    for (let i = 0; i < this.post8Buffers.length; i++) {

      // 8 bit buffers have unsigned byte textures of type gl.RGBA8
      this.post8Buffers[i] = gl.createFramebuffer()
      gl.bindFramebuffer(gl.FRAMEBUFFER, this.post8Buffers[i]);
      gl.drawBuffers([gl.COLOR_ATTACHMENT0]);

      this.post8Targets[i] = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, this.post8Targets[i]);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, gl.drawingBufferWidth, gl.drawingBufferHeight, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, this.post8Targets[i], 0);

      FBOstatus = gl.checkFramebufferStatus(gl.FRAMEBUFFER);
      if (FBOstatus != gl.FRAMEBUFFER_COMPLETE) {
        console.error("GL_FRAMEBUFFER_COMPLETE failed, CANNOT use 8 bit FBO\n");
      }

      // 32 bit buffers have float textures of type gl.RGBA32F
      this.post32Buffers[i] = gl.createFramebuffer()
      gl.bindFramebuffer(gl.FRAMEBUFFER, this.post32Buffers[i]);
      gl.drawBuffers([gl.COLOR_ATTACHMENT0]);

      this.post32Targets[i] = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, this.post32Targets[i]);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA32F, gl.drawingBufferWidth, gl.drawingBufferHeight, 0, gl.RGBA, gl.FLOAT, null);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, this.post32Targets[i], 0);

      FBOstatus = gl.checkFramebufferStatus(gl.FRAMEBUFFER);
      if (FBOstatus != gl.FRAMEBUFFER_COMPLETE) {
        console.error("GL_FRAMEBUFFER_COMPLETE failed, CANNOT use 8 bit FBO\n");
      }
    }

    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.bindTexture(gl.TEXTURE_2D, null);
  }


  updateTime(deltaTime: number, currentTime: number) {
    this.deferredShader.setTime(currentTime);
    for (let pass of this.post8Passes) pass.setTime(currentTime);
    for (let pass of this.post32Passes) pass.setTime(currentTime);
    this.currentTime = currentTime;
  }


  clear() {
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
  }


  clearGB() {
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.gBuffer);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  }


  renderToGBuffer(camera: Camera, gbProg: ShaderProgram, drawables: Array<Drawable>) {
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.gBuffer);
    gl.viewport(0, 0, gl.drawingBufferWidth, gl.drawingBufferHeight);
    gl.enable(gl.DEPTH_TEST);

    let model = mat4.create();
    let viewProj = mat4.create();
    let view = camera.viewMatrix;
    let proj = camera.projectionMatrix;
    let color = vec4.fromValues(0.5, 0.5, 0.5, 1);

    mat4.identity(model);
    mat4.multiply(viewProj, camera.projectionMatrix, camera.viewMatrix);
    gbProg.setModelMatrix(model);
    gbProg.setViewProjMatrix(viewProj);
    gbProg.setGeometryColor(color);
    gbProg.setViewMatrix(view);
    gbProg.setProjMatrix(proj);

    gbProg.setTime(this.currentTime);

    for (let drawable of drawables) {
      gbProg.draw(drawable);
    }

    gl.bindFramebuffer(gl.FRAMEBUFFER, null);

  }

  renderFromGBuffer(camera: Camera) {
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.post32Buffers[0]);
    gl.viewport(0, 0, gl.drawingBufferWidth, gl.drawingBufferHeight);
    gl.disable(gl.DEPTH_TEST);
    gl.enable(gl.BLEND);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);

    let view = camera.viewMatrix;
    let proj = camera.projectionMatrix;
    this.deferredShader.setViewMatrix(view);
    this.deferredShader.setProjMatrix(proj);

    for (let i = 0; i < this.gbTargets.length; i ++) {
      gl.activeTexture(gl.TEXTURE0 + i);
      gl.bindTexture(gl.TEXTURE_2D, this.gbTargets[i]);
    }

    this.deferredShader.draw();
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  }


  // TODO: pass any info you need as args
  renderPostProcessHDR() {
    // TODO: replace this with your post 32-bit pipeline
    // the loop shows how to swap between frame buffers and textures given a list of processes,
    // but specific shaders (e.g. bloom) need specific info as textures
    let i = 0;
    for (i = 0; i < this.post32Passes.length; i++){
      // Pingpong framebuffers for each pass.
      // In other words, repeatedly flip between storing the output of the
      // current post-process pass in post32Buffers[1] and post32Buffers[0].
      gl.bindFramebuffer(gl.FRAMEBUFFER, this.post32Buffers[(i + 1) % 2]);

      gl.viewport(0, 0, gl.drawingBufferWidth, gl.drawingBufferHeight);
      gl.disable(gl.DEPTH_TEST);
      gl.enable(gl.BLEND);
      gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);

      // Recall that each frame buffer is associated with a texture that stores
      // the output of a render pass. post32Targets is the array that stores
      // these textures, so we alternate reading from the 0th and 1th textures
      // each frame (the texture we wrote to in our previous render pass).
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, this.post32Targets[(i) % 2]);

      this.post32Passes[i].draw();

      // bind default frame buffer
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    }

    // apply tonemapping
    // TODO: if you significantly change your framework, ensure this doesn't cause bugs!
    // render to the first 8 bit buffer if there is more post, else default buffer
    if (this.post8Passes.length > 0) {
      gl.bindFramebuffer(gl.FRAMEBUFFER, this.post8Buffers[0]);
    }
    else {
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    }

    gl.viewport(0, 0, gl.drawingBufferWidth, gl.drawingBufferHeight);

    gl.disable(gl.DEPTH_TEST);
    gl.enable(gl.BLEND);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);

    gl.activeTexture(gl.TEXTURE0);
    // bound texture is the last one processed before

    gl.bindTexture(gl.TEXTURE_2D, this.post32Targets[Math.max(0, i) % 2]);

    this.tonemapPass.draw();

  }


  // TODO: pass any info you need as args
  renderPostProcessLDR() {
    // TODO: replace this with your post 8-bit pipeline
    // the loop shows how to swap between frame buffers and textures given a list of processes,
    // but specific shaders (e.g. motion blur) need specific info as textures
    for (let i = 0; i < this.post8Passes.length; i++){
      // pingpong framebuffers for each pass
      // if this is the last pass, default is bound
      if (i < this.post8Passes.length - 1) gl.bindFramebuffer(gl.FRAMEBUFFER, this.post8Buffers[(i + 1) % 2]);
      else gl.bindFramebuffer(gl.FRAMEBUFFER, null);

      gl.viewport(0, 0, gl.drawingBufferWidth, gl.drawingBufferHeight);
      gl.disable(gl.DEPTH_TEST);
      gl.enable(gl.BLEND);
      gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);

      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, this.post8Targets[(i) % 2]);

      this.post8Passes[i].draw();

      // bind default
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    }
  }

};

export default OpenGLRenderer;
