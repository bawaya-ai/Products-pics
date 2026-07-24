/** @type {import('next').NextConfig} */
const nextConfig = {
  // Native/heavy packages must stay external to the server bundle (Vercel/Node).
  serverExternalPackages: ['sharp', 'onnxruntime-node'],
};
export default nextConfig;
