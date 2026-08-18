import {
	Color
} from '../../three.module.js';


const LuminosityHighPassShader = {

	name: 'LuminosityHighPassShader',

	uniforms: {

		'tDiffuse': { value: null },
		'luminosityThreshold': { value: 1.0 },
		'smoothWidth': { value: 1.0 },
		'defaultColor': { value: new Color( 0x000000 ) },
		'defaultOpacity': { value: 0.0 },
		'debugHighlightNonFinite': { value: false }

	},

	vertexShader:`

		varying vec2 vUv;

		void main() {

			vUv = uv;

			gl_Position = projectionMatrix * modelViewMatrix * vec4( position, 1.0 );

		}`,

	fragmentShader:`

		uniform sampler2D tDiffuse;
		uniform vec3 defaultColor;
		uniform float defaultOpacity;
		uniform float luminosityThreshold;
		uniform float smoothWidth;
		uniform bool debugHighlightNonFinite;

		varying vec2 vUv;

		void main() {

			vec4 texel = texture2D( tDiffuse, vUv );

			// This is the first place bloom reads the scene's raw linear HDR color, completely
			// unclamped. A single non-finite pixel here (a grazing-angle highlight, or thin
			// double-sided geometry producing an unstable shading result) survives through five
			// levels of Gaussian downsampling — at the coarsest mip a single texel's blur kernel
			// covers a large fraction of the whole frame, so one bad source pixel can black out
			// (or, with debugHighlightNonFinite, flash magenta across) much more than itself once
			// additively composited back at full resolution. NaN != NaN is true for any NaN by
			// IEEE754 and is reliable in every GLSL version, unlike clamp()/min() with a NaN
			// operand, which the spec leaves implementation-defined.
			bool nonFinite = texel.r != texel.r || texel.g != texel.g || texel.b != texel.b
				|| abs(texel.r) > 1.0e5 || abs(texel.g) > 1.0e5 || abs(texel.b) > 1.0e5;
			vec3 safeColor = nonFinite ? vec3( 0.0 ) : min( texel.rgb, vec3( 64.0 ) );

			float v = luminance( safeColor );

			vec4 outputColor = vec4( defaultColor.rgb, defaultOpacity );

			float alpha = smoothstep( luminosityThreshold, luminosityThreshold + smoothWidth, v );

			vec4 result = mix( outputColor, vec4( safeColor, texel.a ), alpha );
			if ( debugHighlightNonFinite && nonFinite ) result = vec4( 4.0, 0.0, 4.0, 1.0 );

			gl_FragColor = result;

		}`

};

export { LuminosityHighPassShader };
