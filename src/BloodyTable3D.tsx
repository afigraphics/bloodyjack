import { Canvas, useFrame } from '@react-three/fiber';
import { Float, Sparkles } from '@react-three/drei';
import { Bloom, EffectComposer } from '@react-three/postprocessing';
import { useRef } from 'react';
import type { Group } from 'three';

function Chip({ position, color, delay=0 }:{position:[number,number,number];color:string;delay?:number}) {
  const ref=useRef<Group>(null);
  useFrame(({clock})=>{if(ref.current)ref.current.rotation.y=clock.elapsedTime*.34+delay});
  return <group ref={ref} position={position}>
    {[0,.09,.18].map((y,i)=><mesh key={i} position={[0,y,0]} castShadow>
      <cylinderGeometry args={[.19,.19,.075,32]}/>
      <meshStandardMaterial color={i===1?'#eee7df':color} metalness={.28} roughness={.32} emissive={color} emissiveIntensity={.12}/>
    </mesh>)}
  </group>;
}

function Scene({active}:{active:boolean}) {
  const table=useRef<Group>(null);
  useFrame(({pointer,clock})=>{if(!table.current)return;table.current.rotation.z+=(pointer.x*.018-table.current.rotation.z)*.045;table.current.rotation.x+=((-.035+pointer.y*.014)-table.current.rotation.x)*.045;table.current.position.y=Math.sin(clock.elapsedTime*.45)*.015});
  return <>
    <ambientLight intensity={.7}/>
    <spotLight position={[0,7,2]} angle={.72} penumbra={.82} intensity={active?16:11} color={active?'#ff9aa8':'#fff0f2'} castShadow/>
    <pointLight position={[-4,1.2,1]} intensity={5.5} distance={8} color="#ff173b"/>
    <pointLight position={[4,1,-1]} intensity={4} distance={7} color="#8b1025"/>
    <group ref={table} rotation={[-.035,0,0]}>
      <Chip position={[-3.7,.45,-1.75]} color="#b41631"/>
      <Chip position={[3.7,.45,-1.75]} color="#f0c84c" delay={1}/>
      <Chip position={[0,.45,1.9]} color="#172c4a" delay={2}/>
      <Float speed={1.6} rotationIntensity={.15} floatIntensity={.15}>
        <mesh position={[0,.68,-2.02]} rotation={[-Math.PI/2,0,0]}>
          <torusGeometry args={[.35,.025,12,64]}/>
          <meshStandardMaterial color="#ff6479" emissive="#ff2143" emissiveIntensity={4} toneMapped={false}/>
        </mesh>
      </Float>
    </group>
    <Sparkles count={active?58:24} scale={[10,3,5]} size={1.5} speed={.24} color="#ff3855" opacity={.46}/>
    <EffectComposer multisampling={4}>
      <Bloom intensity={active ? .8 : .42} luminanceThreshold={.72} luminanceSmoothing={.28} mipmapBlur/>
    </EffectComposer>
  </>;
}

export default function BloodyTable3D({active}:{active:boolean}) {
  return <div className="bloody-canvas" aria-hidden="true">
    <Canvas dpr={[1,1.65]} camera={{position:[0,9.5,6.4],fov:43}} shadows gl={{antialias:true,alpha:true,powerPreference:'high-performance'}} onCreated={({gl})=>gl.setClearColor(0x000000,0)}>
      <Scene active={active}/>
    </Canvas>
  </div>;
}
