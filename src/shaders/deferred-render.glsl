#version 300 es
precision highp float;

#define EPS 0.0001
#define PI 3.1415962

in vec2 fs_UV;
out vec4 out_Col;

uniform sampler2D u_gb0;
uniform sampler2D u_gb1;
uniform sampler2D u_gb2;

uniform float u_Time;

uniform mat4 u_View;
uniform vec4 u_CamPos;   


void main() { 
	// read from GBuffers

	vec4 gb2 = texture(u_gb2, fs_UV);

	vec3 col = gb2.xyz;
	col = gb2.xyz;

	out_Col = vec4(col, 1.0);
}