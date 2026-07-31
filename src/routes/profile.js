import express from 'express';
import bcrypt from 'bcryptjs';
import { db } from '../lib/db.js';
import { requireAuth } from '../middleware/auth.js';
import { cleanText } from '../lib/helpers.js';

export const router = express.Router();

const updateProfile = db.prepare(
  `UPDATE users SET name = @name, phone = @phone, contact_other = @contact_other,
                    bio = @bio, updated_at = datetime('now')
   WHERE id = @id`
);
const getPasswordHash = db.prepare('SELECT password_hash FROM users WHERE id = ?');
const updatePassword = db.prepare(
  "UPDATE users SET password_hash = ?, updated_at = datetime('now') WHERE id = ?"
);

// requireAuth é aplicado rota a rota: um router.use() aqui apanharia todos os
// pedidos que atravessam este router (está montado na raiz), incluindo os eventos.
router.get('/perfil', requireAuth, (req, res) => {
  res.render('profile', { title: 'O meu perfil', errors: [], values: req.user });
});

router.post('/perfil', requireAuth, (req, res) => {
  const values = {
    id: req.user.id,
    name: cleanText(req.body.name, 120),
    phone: cleanText(req.body.phone, 40),
    contact_other: cleanText(req.body.contact_other, 120),
    bio: cleanText(req.body.bio, 500)
  };
  const errors = [];

  if (values.name.length < 2) errors.push('Indica o teu nome.');
  if (!values.phone && !values.contact_other) {
    errors.push('Indica pelo menos um contacto (telemóvel ou outro).');
  }

  if (errors.length) {
    return res.status(400).render('profile', {
      title: 'O meu perfil',
      errors,
      values: { ...req.user, ...values }
    });
  }

  updateProfile.run(values);
  res.flash('success', 'Perfil actualizado.');
  return res.redirect('/perfil');
});

router.post('/perfil/palavra-passe', requireAuth, async (req, res) => {
  const current = String(req.body.current_password ?? '');
  const next = String(req.body.new_password ?? '');
  const confirm = String(req.body.new_password_confirm ?? '');
  const errors = [];

  const { password_hash } = getPasswordHash.get(req.user.id);
  if (!(await bcrypt.compare(current, password_hash))) {
    errors.push('A palavra-passe actual está errada.');
  }
  if (next.length < 8) errors.push('A nova palavra-passe precisa de pelo menos 8 caracteres.');
  if (next !== confirm) errors.push('A confirmação não coincide.');

  if (errors.length) {
    return res.status(400).render('profile', {
      title: 'O meu perfil',
      errors,
      values: req.user
    });
  }

  updatePassword.run(await bcrypt.hash(next, 12), req.user.id);
  res.flash('success', 'Palavra-passe alterada.');
  return res.redirect('/perfil');
});
