import { createBrowserRouter, RouterProvider } from 'react-router-dom'
import { TooltipProvider } from './components/common/Tooltip'
import { Landing } from './pages/Landing'
import { MeetingPage } from './pages/MeetingPage'

const router = createBrowserRouter([
  { path: '/', element: <Landing /> },
  { path: '/:code', element: <MeetingPage /> },
  { path: '*', element: <Landing /> },
])

export default function App() {
  return (
    <TooltipProvider delayDuration={400} skipDelayDuration={200}>
      <RouterProvider router={router} />
    </TooltipProvider>
  )
}
