import { auto } from 'manate/react'
import { Button } from 'antd'
import './module-page.styl'

export default auto(function ModulePage ({ title, name, onClose, children }) {
  return (
    <main className='module-workspace' aria-label={name}>
      <header className='module-workspace-header pd2'>
        <h2>{title}</h2>
        <Button onClick={onClose}>Back to workspace</Button>
      </header>
      <div className='module-settings-content pd2 overscroll-y'>
        {children}
      </div>
    </main>
  )
})
